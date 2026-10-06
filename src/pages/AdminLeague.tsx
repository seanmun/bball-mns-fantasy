import { sport } from '../lib/sport/index'
import { SeasonCalendar } from '../components/SeasonCalendar'
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useUser } from '@clerk/clerk-react'
import { toast } from 'sonner'
import { useApi } from '../hooks/useApi'
import { useLeague } from '../contexts/LeagueContext'
import type { League } from '../types/league'
import type { LeagueConfig } from '../types/leagueConfig'

export function AdminLeague() {
  const { user } = useUser()
  const { currentLeague, loading, refreshLeagues } = useLeague()
  const { apiFetch } = useApi()

  const [name, setName] = useState('')
  const [config, setConfig] = useState<LeagueConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The aprons toggle: the engine treats zero thresholds as "off", so
  // the switch only has to open the fields; Off zeroes them.
  const [apronsOpen, setApronsOpen] = useState(false)

  useEffect(() => {
    if (currentLeague) {
      setName(currentLeague.name)
      setConfig(currentLeague.config)
    }
  }, [currentLeague])

  if (loading) return <Centered>Loading…</Centered>

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

  const isCommissioner =
    !!user && currentLeague.commissionerId === user.id

  if (!isCommissioner) {
    return (
      <Centered>
        <p className="mb-4">Only the commissioner can change league settings.</p>
        <Link
          to={`/league/${currentLeague.id}`}
          className="text-green-400 hover:text-green-300"
        >
          ← Back to league
        </Link>
      </Centered>
    )
  }

  if (!config) return <Centered>Loading config…</Centered>

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await apiFetch<League>(`/api/leagues/${currentLeague.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: name.trim(), config }),
      })
      refreshLeagues()
      toast.success('League settings saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">League Settings</h1>
          <p className="text-gray-400 mt-1">
            {currentLeague.name} · {currentLeague.sport.toUpperCase()} ·{' '}
            {currentLeague.seasonYear}
          </p>
        </div>
        <Link
          to={`/league/${currentLeague.id}`}
          className="text-sm text-gray-400 hover:text-white"
        >
          ← Back to league
        </Link>
      </div>

      <p className="text-sm text-gray-400 mb-6">
        Override anything from the {sport.leagueLabel} preset. Everything else stays at the
        default. Changes apply immediately on save — they don't affect already-
        locked rosters/keepers/fees.
      </p>

      {error && (
        <div className="mb-4 p-3 bg-red-900/30 border border-red-500/30 rounded-lg text-red-300 text-sm">
          {error}
        </div>
      )}

      <div className="space-y-6">
        <Section title="Identity">
          <Row label="League Name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              className={inputClass}
            />
          </Row>
        </Section>

        <Section title="Season + Schedule">
          <NumRow
            label="Start Date (YYYY-MM-DD)"
            value={config.season.startDate}
            onChange={(v) =>
              setConfig({ ...config, season: { ...config.season, startDate: String(v) } })
            }
            asText
          />
          <NumRow
            label="Regular-Season Weeks"
            value={config.season.weeks}
            onChange={(v) =>
              setConfig({ ...config, season: { ...config.season, weeks: Number(v) } })
            }
          />
          <NumRow
            label="Trade Deadline (week #)"
            value={config.schedule.tradeDeadlineWeek}
            onChange={(v) =>
              setConfig({
                ...config,
                schedule: { ...config.schedule, tradeDeadlineWeek: Number(v) },
              })
            }
          />
          <NumRow
            label="Playoff Teams"
            value={config.schedule.playoffTeams}
            onChange={(v) =>
              setConfig({
                ...config,
                schedule: { ...config.schedule, playoffTeams: Number(v) },
              })
            }
          />
          <NumRow
            label="Playoff Weeks"
            value={config.schedule.playoffWeeks}
            onChange={(v) =>
              setConfig({
                ...config,
                schedule: { ...config.schedule, playoffWeeks: Number(v) },
              })
            }
          />
          <NumRow
            label="First-Round Byes"
            value={config.schedule.playoffByeTeams}
            onChange={(v) =>
              setConfig({
                ...config,
                schedule: { ...config.schedule, playoffByeTeams: Number(v) },
              })
            }
          />
          <Row label="The season, week by week">
            <span className="text-xs text-gray-500">from the real schedule</span>
          </Row>
          <SeasonCalendar
            leagueId={currentLeague.id}
            startDate={config.season.startDate}
            weeks={config.season.weeks}
            playoffWeeks={config.schedule.playoffWeeks}
            combined={config.schedule.combinedWeeks ?? []}
            onChange={(combinedWeeks) =>
              setConfig({ ...config, schedule: { ...config.schedule, combinedWeeks } })
            }
          />
        </Section>

        <Section title="Roster">
          <NumRow
            label="Active Roster Size"
            value={config.roster.activeSize}
            onChange={(v) =>
              setConfig({ ...config, roster: { ...config.roster, activeSize: Number(v) } })
            }
          />
          <NumRow
            label="Starters per Matchup"
            value={config.roster.starterSize}
            onChange={(v) =>
              setConfig({ ...config, roster: { ...config.roster, starterSize: Number(v) } })
            }
          />
          <Row label="Lineup Shape">
            <div className="flex flex-col gap-2">
              {(config.roster.positionSlots ?? []).map((ps, i) => (
                <div key={i} className="flex gap-2">
                  <select
                    value={ps.code}
                    onChange={(e) => {
                      const next = [...(config.roster.positionSlots ?? [])]
                      next[i] = { ...next[i], code: e.target.value }
                      setConfig({ ...config, roster: { ...config.roster, positionSlots: next } })
                    }}
                    className={inputClass}
                  >
                    {['C', 'F', 'G', 'PG', 'SG', 'SF', 'PF', 'GF', 'FC', 'FLEX'].map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={0}
                    value={ps.count}
                    onChange={(e) => {
                      const next = [...(config.roster.positionSlots ?? [])]
                      next[i] = { ...next[i], count: Number(e.target.value) }
                      setConfig({ ...config, roster: { ...config.roster, positionSlots: next } })
                    }}
                    className={inputClass + ' max-w-[6rem]'}
                  />
                  <button
                    type="button"
                    aria-label="Remove slot"
                    onClick={() => {
                      const next = (config.roster.positionSlots ?? []).filter((_, j) => j !== i)
                      setConfig({ ...config, roster: { ...config.roster, positionSlots: next } })
                    }}
                    className="px-3 text-gray-400 hover:text-white"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() =>
                  setConfig({
                    ...config,
                    roster: {
                      ...config.roster,
                      positionSlots: [
                        ...(config.roster.positionSlots ?? []),
                        { code: 'FLEX', count: 1 },
                      ],
                    },
                  })
                }
                className="text-sm text-green-400 hover:text-green-300 self-start"
              >
                + Add a slot
              </button>
            </div>
          </Row>
          {(() => {
            const slots = config.roster.positionSlots ?? []
            const total = slots.reduce((n, x) => n + (x.count || 0), 0)
            if (slots.length === 0) {
              return (
                <p className="text-xs text-gray-500 -mt-1">
                  No shape set — the lineup is all-flex: any {config.roster.activeSize} players
                  start. Add slots to require positions (2 C, 4 F, 4 G).
                </p>
              )
            }
            return (
              <p
                className={
                  'text-xs -mt-1 ' +
                  (total === config.roster.activeSize ? 'text-gray-500' : 'text-yellow-400')
                }
              >
                {total} starting slots vs an active roster of {config.roster.activeSize}.
                {total !== config.roster.activeSize
                  ? ' These should match — otherwise some players can never start.'
                  : ' FLEX slots take any position.'}
              </p>
            )
          })()}

          <Row label="Redshirts Allowed">
            <Toggle
              value={config.roster.redshirtsAllowed}
              onChange={(v) =>
                setConfig({ ...config, roster: { ...config.roster, redshirtsAllowed: v } })
              }
            />
          </Row>
          <p className="text-xs text-gray-500 -mt-1">
            Rookies who have never played can be parked for the season: no roster spot, no cap
            hit, the redshirt fee to place and the activation fee to bring back — once activated,
            that player can never be redshirted again.
          </p>
          <NumRow
            label="IR Slots"
            value={config.roster.irSlots}
            onChange={(v) =>
              setConfig({ ...config, roster: { ...config.roster, irSlots: Number(v) } })
            }
          />
          <NumRow
            label="Max Keepers"
            value={config.roster.maxKeepers}
            onChange={(v) =>
              setConfig({ ...config, roster: { ...config.roster, maxKeepers: Number(v) } })
            }
          />
        </Section>

        <Section title="Draft">
          <NumRow
            label="Draft Rounds"
            value={config.draft.rounds}
            onChange={(v) =>
              setConfig({ ...config, draft: { ...config.draft, rounds: Number(v) } })
            }
          />
          <NumRow
            label="Rookie Draft Rounds"
            value={config.draft.rookieRounds}
            onChange={(v) =>
              setConfig({ ...config, draft: { ...config.draft, rookieRounds: Number(v) } })
            }
          />
          <NumRow
            label="Rookie Years Tracked (future tradeable picks)"
            value={config.draft.rookieYearsTracked}
            onChange={(v) =>
              setConfig({
                ...config,
                draft: { ...config.draft, rookieYearsTracked: Number(v) },
              })
            }
          />
          <Row label="Rookie Order Method">
            <select
              value={config.draft.rookieOrderMethod}
              onChange={(e) =>
                setConfig({
                  ...config,
                  draft: {
                    ...config.draft,
                    rookieOrderMethod: e.target.value as
                      | 'lottery'
                      | 'manual'
                      | 'season_record',
                  },
                })
              }
              className={inputClass}
            >
              <option value="manual">Manual (commissioner sets order)</option>
              <option value="lottery">Lottery (weighted random by record)</option>
              <option value="season_record">Season record (worst → best)</option>
            </select>
          </Row>
          <Row label="Admin Pick Override">
            <Toggle
              value={config.draft.allowAdminOverride}
              onChange={(v) =>
                setConfig({
                  ...config,
                  draft: { ...config.draft, allowAdminOverride: v },
                })
              }
            />
          </Row>
          <p className="text-xs text-gray-500 pt-2">
            Future tradeable picks = {config.draft.rookieRounds} round
            {config.draft.rookieRounds === 1 ? '' : 's'} × {config.draft.rookieYearsTracked} year
            {config.draft.rookieYearsTracked === 1 ? '' : 's'} = {config.draft.rookieRounds * config.draft.rookieYearsTracked} pick
            {config.draft.rookieRounds * config.draft.rookieYearsTracked === 1 ? '' : 's'} per team.
          </p>
        </Section>

        <Section title="Salary Cap (dollars)">
          <NumRow
            label="Base Cap"
            value={config.cap.base}
            onChange={(v) =>
              setConfig({ ...config, cap: { ...config.cap, base: Number(v) } })
            }
          />
          <NumRow
            label="Cap Floor (minimum spend, 0 = none)"
            value={config.cap.floor}
            onChange={(v) =>
              setConfig({ ...config, cap: { ...config.cap, floor: Number(v) } })
            }
          />
          <NumRow
            label="Hard Cap"
            value={config.cap.hardCap}
            onChange={(v) =>
              setConfig({ ...config, cap: { ...config.cap, hardCap: Number(v) } })
            }
          />
          <NumRow
            label="Trade Cap Flex (± dollars)"
            value={config.cap.tradeDelta}
            onChange={(v) =>
              setConfig({ ...config, cap: { ...config.cap, tradeDelta: Number(v) } })
            }
          />
          <Row label="Use Aprons">
            <Toggle
              value={apronsOpen || config.cap.firstApron > 0 || config.cap.secondApron > 0}
              onChange={(v) => {
                setApronsOpen(v)
                if (!v) {
                  setConfig({
                    ...config,
                    cap: { ...config.cap, firstApron: 0, secondApron: 0, penaltyRatePerM: 0 },
                    fees: { ...config.fees, firstApronFee: 0 },
                  })
                }
              }}
            />
          </Row>
          <p className="text-xs text-gray-500 -mt-1">
            Cap dues book at the day&rsquo;s first tip from the roster each team carries in. The
            first apron is a one-time fee for the season; the second-apron penalty only ever
            rises. Off means the app never looks for either.
          </p>
          {apronsOpen || config.cap.firstApron > 0 || config.cap.secondApron > 0 ? (
            <>
              <NumRow
                label="First Apron"
                value={config.cap.firstApron}
                onChange={(v) =>
                  setConfig({ ...config, cap: { ...config.cap, firstApron: Number(v) } })
                }
              />
              <NumRow
                label="First Apron Fee (one-time, dollars)"
                value={config.fees.firstApronFee}
                onChange={(v) =>
                  setConfig({ ...config, fees: { ...config.fees, firstApronFee: Number(v) } })
                }
              />
              <NumRow
                label="Second Apron"
                value={config.cap.secondApron}
                onChange={(v) =>
                  setConfig({ ...config, cap: { ...config.cap, secondApron: Number(v) } })
                }
              />
              <NumRow
                label="Penalty per $1M over second apron (dollars)"
                value={config.cap.penaltyRatePerM}
                onChange={(v) =>
                  setConfig({ ...config, cap: { ...config.cap, penaltyRatePerM: Number(v) } })
                }
              />
              {config.cap.firstApron > 0 &&
              config.cap.secondApron > 0 &&
              config.cap.secondApron < config.cap.firstApron ? (
                <p className="text-xs -mt-1" style={{ color: 'var(--color-key, #ffb000)' }}>
                  The second apron sits below the first — leagues normally set it higher.
                </p>
              ) : null}
            </>
          ) : null}
        </Section>

        <Section title="Fees (dollars)">
          <NumRow
            label="Buy-In"
            value={config.fees.buyIn}
            onChange={(v) =>
              setConfig({ ...config, fees: { ...config.fees, buyIn: Number(v) } })
            }
          />
          <NumRow
            label="Franchise Tag Fee"
            value={config.fees.franchiseTagFee}
            onChange={(v) =>
              setConfig({
                ...config,
                fees: { ...config.fees, franchiseTagFee: Number(v) },
              })
            }
          />
          <NumRow
            label="Redshirt Fee"
            value={config.fees.redshirtFee}
            onChange={(v) =>
              setConfig({
                ...config,
                fees: { ...config.fees, redshirtFee: Number(v) },
              })
            }
          />
          <NumRow
            label="Mid-Season Activation Fee"
            value={config.fees.activationFee}
            onChange={(v) =>
              setConfig({
                ...config,
                fees: { ...config.fees, activationFee: Number(v) },
              })
            }
          />
        </Section>

        <Section title="Year to Year">
          <Row label="Rookie Draft">
            <Toggle
              value={config.draft.rookieDraftEnabled ?? false}
              onChange={(v) =>
                setConfig({ ...config, draft: { ...config.draft, rookieDraftEnabled: v } })
              }
            />
          </Row>
          <p className="text-xs text-gray-500 -mt-1">
            On: each new season opens with a rookie draft, then keepers, then the regular draft.
            Off: keepers straight to one regular draft.
          </p>
          <NumRow
            label="Keepers Allowed"
            value={config.roster.maxKeepers}
            onChange={(v) =>
              setConfig({ ...config, roster: { ...config.roster, maxKeepers: Number(v) } })
            }
          />
          <NumRow
            label="Cap Increase per Year (%)"
            value={config.cap.annualIncreasePct ?? 0}
            onChange={(v) =>
              setConfig({ ...config, cap: { ...config.cap, annualIncreasePct: Number(v) } })
            }
          />
          <p className="text-xs text-gray-500 -mt-1">
            Applied to floor, aprons and hard cap when you start the next season. You can still
            hand-edit the ladder any time.
          </p>
        </Section>

        <Section title="Prize Pool (tracked, never handled)">
          <NumRow
            label="Cash Pot (USD)"
            value={config.prizes?.potUsd ?? 0}
            onChange={(v) =>
              setConfig({
                ...config,
                prizes: {
                  potUsd: Number(v),
                  walletAddress: config.prizes?.walletAddress ?? null,
                  splits: config.prizes?.splits ?? [],
                },
              })
            }
          />
          <Row label="Pool Wallet (ETH address)">
            <input
              type="text"
              value={config.prizes?.walletAddress ?? ''}
              placeholder="0x… (optional — watched read-only, value adds to the pot)"
              onChange={(e) =>
                setConfig({
                  ...config,
                  prizes: {
                    potUsd: config.prizes?.potUsd ?? 0,
                    walletAddress: e.target.value.trim() || null,
                    splits: config.prizes?.splits ?? [],
                  },
                })
              }
              className={inputClass}
            />
          </Row>
          <p className="text-xs text-gray-500">
            The address is public: anyone can see its balance and full history on-chain.
            The app only watches it — no keys, no transactions.
          </p>
          {(config.prizes?.splits ?? []).map((sp, i) => (
            <Row key={i} label={`Split ${i + 1}`}>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={sp.label}
                  placeholder="1st place"
                  onChange={(e) => {
                    const splits = [...(config.prizes?.splits ?? [])]
                    splits[i] = { ...splits[i], label: e.target.value }
                    setConfig({ ...config, prizes: { potUsd: config.prizes?.potUsd ?? 0, walletAddress: config.prizes?.walletAddress ?? null, splits } })
                  }}
                  className={inputClass}
                />
                <input
                  type="number"
                  value={sp.share}
                  onChange={(e) => {
                    const splits = [...(config.prizes?.splits ?? [])]
                    splits[i] = { ...splits[i], share: Number(e.target.value) }
                    setConfig({ ...config, prizes: { potUsd: config.prizes?.potUsd ?? 0, walletAddress: config.prizes?.walletAddress ?? null, splits } })
                  }}
                  className={inputClass + ' max-w-[6rem]'}
                />
                <button
                  type="button"
                  aria-label="Remove split"
                  onClick={() => {
                    const splits = (config.prizes?.splits ?? []).filter((_, j) => j !== i)
                    setConfig({ ...config, prizes: { potUsd: config.prizes?.potUsd ?? 0, walletAddress: config.prizes?.walletAddress ?? null, splits } })
                  }}
                  className="px-3 text-gray-400 hover:text-white"
                >
                  ✕
                </button>
              </div>
            </Row>
          ))}
          {(() => {
            const total = (config.prizes?.splits ?? []).reduce((n, sp) => n + (sp.share || 0), 0)
            return total !== 100 && (config.prizes?.splits ?? []).length > 0 ? (
              <p className="text-xs text-yellow-400">Splits add to {total}% — aim for 100%.</p>
            ) : null
          })()}
          <button
            type="button"
            onClick={() =>
              setConfig({
                ...config,
                prizes: {
                  potUsd: config.prizes?.potUsd ?? 0,
                  walletAddress: config.prizes?.walletAddress ?? null,
                  splits: [
                    ...(config.prizes?.splits ?? []),
                    { label: (config.prizes?.splits ?? []).length === 0 ? '1st place' : (config.prizes?.splits ?? []).length === 1 ? '2nd place' : '', share: 0 },
                  ],
                },
              })
            }
            className="text-sm text-green-400 hover:text-green-300"
          >
            + Add a split
          </button>
        </Section>

        <Section title="Scoring">
          <Row label="Mode">
            <select
              value={config.scoring.mode}
              onChange={(e) =>
                setConfig({
                  ...config,
                  scoring: {
                    ...config.scoring,
                    mode: e.target.value as 'matchup_record' | 'category_record',
                  },
                })
              }
              className={inputClass}
            >
              <option value="category_record">Category record (9-cat W/L/T)</option>
              <option value="matchup_record">Matchup record (single W/L)</option>
            </select>
          </Row>
          <Row label="Categories">
            <div className="text-gray-400 text-sm py-2">
              {config.scoring.categories.join(' · ')}
            </div>
          </Row>
        </Section>

        <Section title="Keeper Rules">
          <Row label="Advance Rule">
            <select
              value={config.keeper.advanceRule}
              onChange={(e) =>
                setConfig({
                  ...config,
                  keeper: {
                    ...config.keeper,
                    advanceRule: e.target.value as 'minus_one' | 'flat' | 'custom',
                  },
                })
              }
              className={inputClass}
            >
              <option value="minus_one">Minus one (keeper costs one round earlier)</option>
              <option value="flat">Flat (same round year over year)</option>
              <option value="custom">Custom (handled externally)</option>
            </select>
          </Row>
          <Row label="Fallback Round">
            <input
              type="number"
              value={config.keeper.fallbackRound ?? ''}
              placeholder="leave blank to require explicit per-player"
              onChange={(e) =>
                setConfig({
                  ...config,
                  keeper: {
                    ...config.keeper,
                    fallbackRound:
                      e.target.value === '' ? null : Number(e.target.value),
                  },
                })
              }
              className={inputClass}
            />
          </Row>
          <Row label="Franchise Tag Allowed">
            <Toggle
              value={config.keeper.franchiseTagAllowed}
              onChange={(v) =>
                setConfig({
                  ...config,
                  keeper: { ...config.keeper, franchiseTagAllowed: v },
                })
              }
            />
          </Row>
        </Section>
      </div>

      <div className="mt-8 flex items-center gap-3 sticky bottom-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-3 bg-green-500 hover:bg-green-400 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-black font-bold rounded-lg transition-colors"
        >
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
        <Link
          to={`/league/${currentLeague.id}`}
          className="px-6 py-3 bg-mns-card hover:bg-mns-hover border border-gray-700 text-white font-semibold rounded-lg transition-colors"
        >
          Cancel
        </Link>
      </div>
    </div>
  )
}

const inputClass =
  'w-full px-3 py-2 bg-mns-dark border border-gray-700 rounded text-white placeholder-gray-500 focus:border-green-400 focus:outline-none'

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="mns-page py-12 text-center text-gray-300">
      {children}
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="bg-mns-card border border-gray-800 rounded-lg p-5">
      <h2 className="text-lg font-bold mb-4">{title}</h2>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3 items-center">
      <label className="text-sm text-gray-300 sm:col-span-1">{label}</label>
      <div className="sm:col-span-2">{children}</div>
    </div>
  )
}

function NumRow({
  label,
  value,
  onChange,
  asText,
}: {
  label: string
  value: number | string
  onChange: (v: number | string) => void
  asText?: boolean
}) {
  // Money-sized numbers render with commas — 1,500,000 and 15,000,000
  // must be tellable apart at a glance. Typed commas (or anything
  // non-numeric) are stripped before parsing, so paste works too.
  return (
    <Row label={label}>
      <input
        type="text"
        inputMode={asText ? undefined : 'numeric'}
        value={
          asText ? value : typeof value === 'number' ? value.toLocaleString('en-US') : value
        }
        onChange={(e) =>
          onChange(asText ? e.target.value : Number(e.target.value.replace(/[^0-9.-]/g, '')) || 0)
        }
        className={inputClass}
      />
    </Row>
  )
}

function Toggle({
  value,
  onChange,
}: {
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`px-3 py-1.5 text-sm font-semibold rounded transition-colors ${
        value
          ? 'bg-green-500 text-black hover:bg-green-400'
          : 'bg-mns-dark border border-gray-700 text-gray-400 hover:text-white'
      }`}
    >
      {value ? 'On' : 'Off'}
    </button>
  )
}
