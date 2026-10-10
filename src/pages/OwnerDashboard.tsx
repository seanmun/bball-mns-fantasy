import React, { Fragment, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useUser } from '@clerk/clerk-react'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, EllipsisVertical, Lock, Settings, X } from 'lucide-react'
import { useApi } from '../hooks/useApi'
import { Button, Chip, EmptyState, PageHeader, Skeleton } from '../ui/components'
import { useLeague } from '../contexts/LeagueContext'
import { PlayerName } from '../components/InjuryTag'
import { RangeChips, type RangeKey, type StatAvg } from '../components/StatTable'
import { PlayerCard, isFreshNews } from '../components/PlayerCard'
import { StrategyDials } from '../components/StrategyDials'
import { KeeperPlanner } from '../components/KeeperPlanner'
import { COUNTS_AGAINST_CAP, HOLDS_ROSTER_SPOT } from '../lib/season/roster'
import { assignSlots } from '../lib/season/positions'
import { playerLocked, tipClock } from '../lib/season/locks'
import { penaltyRate } from '../rules/capRules'

interface OwnerInfo {
  userId: string | null
  displayName: string | null
  email: string
  emailPrefs?: Record<string, boolean>
}
interface TeamInfo {
  id: string
  name: string
  logo?: string | null
  aiPrefs?: Record<string, unknown>
  owners: OwnerInfo[]
  picks?: Array<{
    id: string
    seasonYear: number
    round: number
    originalTeamId: string
    originalTeamName: string
  }>
}
interface RosterPlayer {
  id: string
  name: string
  position: string | null
  salary: number | null
  teamCode: string | null
  teamId: string | null
  slot: string | null
  onIR: boolean
  isRookie: boolean
  redshirtUsed?: boolean
  yearsPro?: number | null
  leaguePresence?: string | null
  presenceOverride?: string | null
  injuryStatus?: string | null
  injuryNote?: string | null
  injuryUpdatedAt?: string | null
  keeperRound?: number | null
  avg?: {
    gp: number
    ppg: number
    rpg: number
    apg: number
    fgPct: number
  } | null
}
interface DayGame {
  opp: string
  home: boolean
  tip: string
  state: 'pre' | 'in' | 'post'
}
interface DayLine {
  min: number
  pts: number
  reb: number
  ast: number
  stl: number
  blk: number
  fgm: number
  fga: number
}
interface FeeLine {
  label: string
  amount: number
  note: string | null
}
interface FeesPayload {
  roster: { used: number; size: number; redshirts: number; intStash: number; ir: number }
  lines: FeeLine[]
  total: number
  // Cap dues: what the ledger has booked, and what will book at the
  // next first tip unless the roster gets under.
  dues?: {
    firstApronFee: number
    secondApronPenalty: number
    pendingFirstApronFee: number
    pendingSecondApronPenalty: number
    booksAt: string | null
  }
}
interface PendingClaim {
  id: string
  addNames: string[]
  dropName: string | null
  clearsOn: string
}
interface LineupDay {
  date: string
  today: string
  locked: boolean
  editable: boolean
  slots: Record<string, string>
  games: Record<string, DayGame>
  lines: Record<string, DayLine>
}

const M = 1_000_000
const fmtM = (n: number) => `$${(n / M).toFixed(1)}M`

// Eastern calendar day, same convention as the server.
const ET_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const etToday = () => ET_DAY.format(new Date())
const shiftDate = (date: string, days: number) =>
  new Date(new Date(`${date}T12:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10)
const fmtDay = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
const fmtTip = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  })

// The cap picture, mns-style: one bar, four thresholds, current dues.
function CapCard({
  capUsed,
  cap,
  fees,
  dues,
}: {
  capUsed: number
  cap: { floor: number; base: number; firstApron: number; secondApron: number; hardCap: number }
  fees: { firstApronFee: number; penaltyRatePerM: number }
  dues: NonNullable<FeesPayload['dues']> | null
}) {
  const pct = (v: number) => Math.min(100, (v / cap.hardCap) * 100)
  const booked = (dues?.firstApronFee ?? 0) + (dues?.secondApronPenalty ?? 0)
  const pending = (dues?.pendingFirstApronFee ?? 0) + (dues?.pendingSecondApronPenalty ?? 0)
  const booksAt = dues?.booksAt ? tipClock(dues.booksAt) : null
  const thresholds = [
    { label: 'floor', value: cap.floor, color: 'var(--color-muted-foreground)' },
    { label: '1st apron', value: cap.firstApron, color: 'var(--color-key, #ffb000)' },
    { label: '2nd apron', value: cap.secondApron, color: 'var(--color-pick-pending, #00e5ff)' },
    { label: 'hard cap', value: cap.hardCap, color: 'var(--color-pick-loss, #ff453a)' },
  ].filter((t) => t.value > 0)
  const overSecond = Math.max(0, capUsed - cap.secondApron)
  return (
    <div className="mb-6 rounded-lg border border-[var(--color-border)] bg-mns-card p-4">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-sm font-bold uppercase tracking-wider text-[var(--color-muted-foreground)]">
          Salary cap
        </span>
        <span className="tabular-nums">
          <b>{fmtM(capUsed)}</b>
          <span className="text-sm text-[var(--color-muted-foreground)]">
            {' '}of {fmtM(cap.hardCap)} · {fmtM(Math.max(0, cap.hardCap - capUsed))} room
          </span>
        </span>
      </div>
      <div className="relative h-3 rounded-full bg-[var(--color-border)] overflow-hidden">
        <div
          className="absolute inset-y-0 left-0"
          style={{
            width: `${pct(capUsed)}%`,
            background:
              capUsed > cap.secondApron
                ? 'var(--color-pick-loss, #ff453a)'
                : capUsed > cap.firstApron
                  ? 'var(--color-key, #ffb000)'
                  : 'var(--color-accent)',
          }}
        />
        {thresholds.map((t) => (
          <div
            key={t.label}
            className="absolute inset-y-0 w-0.5"
            style={{ left: `${pct(t.value)}%`, background: t.color }}
          />
        ))}
      </div>
      <div className="mt-2 mb-2 flex flex-wrap gap-x-4 gap-y-1">
        {thresholds.map((t) => (
          <span key={t.label} className="inline-flex items-center gap-1.5 text-[0.72rem] tabular-nums" style={{ color: t.color }}>
            <span aria-hidden="true" style={{ width: 10, height: 3, borderRadius: 2, background: t.color, display: 'inline-block' }} />
            {t.label} {fmtM(t.value)}
          </span>
        ))}
      </div>
      <p className="text-sm">
        {cap.secondApron > 0 && capUsed > cap.secondApron ? (
          <b className="text-[var(--color-pick-loss,#ff453a)]">
            {fmtM(overSecond)} over the 2nd apron (${fees.penaltyRatePerM}/M over)
          </b>
        ) : cap.firstApron > 0 && capUsed > cap.firstApron ? (
          <b style={{ color: 'var(--color-key, #ffb000)' }}>Over the 1st apron (${fees.firstApronFee} one-time fee)</b>
        ) : capUsed < cap.floor ? (
          <span className="text-[var(--color-muted-foreground)]">Below the floor ({fmtM(cap.floor)}).</span>
        ) : (
          <span className="text-[var(--color-accent)]">Under both aprons — no cap dues.</span>
        )}
      </p>
      {/* Dues are booked at first tip from the roster carried in; until
          then the number is a forecast the team can still change. */}
      {pending > 0 ? (
        <p className="mt-1 text-sm">
          <b>${pending}</b> books {booksAt ? `at tonight's first tip (${booksAt} ET)` : 'at the next first tip'} unless
          you get under.
        </p>
      ) : null}
      {booked > 0 ? (
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Booked this season: ${booked} in cap dues.
        </p>
      ) : null}
    </div>
  )
}

// A team's page, one DAY at a time: the lineup as set for that date,
// who plays, and the box lines once games run. Yesterday is locked
// history; today and future days are editable, and a slot set ahead
// sticks when its day arrives. Waivers and trades change what shows
// here; this page just tells the truth about the chosen day.
export function OwnerDashboard() {
  const { leagueId = '', teamId } = useParams()
  const { user } = useUser()
  const { apiFetch } = useApi()
  const { currentLeague } = useLeague()
  const [teams, setTeams] = useState<TeamInfo[] | null>(null)
  const [players, setPlayers] = useState<RosterPlayer[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selDate, setSelDate] = useState(etToday)
  const [day, setDay] = useState<LineupDay | null>(null)
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [confirmDrop, setConfirmDrop] = useState<string | null>(null)
  const [confirmRs, setConfirmRs] = useState<string | null>(null)
  const [claims, setClaims] = useState<PendingClaim[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [range, setRange] = useState<RangeKey>('season')
  const [ranges, setRanges] = useState<Record<string, Record<string, StatAvg> | null> | null>(null)
  const [sortBy, setSortBy] = useState<'gp' | 'ppg' | 'rpg' | 'apg' | 'spg' | 'bpg' | 'tpg' | 'fgPct' | 'cat' | 'catD' | 'salary'>('ppg')
  const [asc, setAsc] = useState(false)
  const [cardId, setCardId] = useState<string | null>(null)
  const [fees, setFees] = useState<FeesPayload | null>(null)
  const [pane, setPane] = useState(0)

  const load = () => {
    Promise.all([
      apiFetch<TeamInfo[]>(`/api/leagues/${leagueId}/teams`),
      apiFetch<RosterPlayer[]>(`/api/leagues/${leagueId}/players`),
    ])
      .then(([t, p]) => {
        setTeams(t)
        setPlayers(p)
      })
      .catch((e: Error) => setError(e.message))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [apiFetch, leagueId])

  // /my-team resolves to the team the caller owns; /team/:teamId shows
  // any team in the league.
  const team = teamId
    ? teams?.find((t) => t.id === teamId)
    : teams?.find((t) => t.owners.some((o) => o.userId != null && o.userId === user?.id))

  const loadDay = () => {
    if (!team) return
    apiFetch<LineupDay>(`/api/leagues/${leagueId}/lineup?date=${selDate}&teamId=${team.id}`)
      .then(setDay)
      .catch(() => setDay(null))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadDay, [apiFetch, leagueId, team?.id, selDate])

  useEffect(() => {
    if (!team?.id) return
    apiFetch<FeesPayload>(`/api/leagues/${leagueId}/fees?teamId=${team.id}`)
      .then(setFees)
      .catch(() => setFees(null))
  }, [apiFetch, leagueId, team?.id, players])

  // Your pending waiver claim belongs on your team page too — the
  // move already in flight is part of the roster's truth.
  const owned = team?.owners.some((o) => o.userId != null && o.userId === user?.id) ?? false
  useEffect(() => {
    if (!owned) {
      setClaims([])
      return
    }
    apiFetch<{ myClaims: PendingClaim[] }>(`/api/leagues/${leagueId}/waivers`)
      .then((w) => setClaims(w.myClaims ?? []))
      .catch(() => setClaims([]))
  }, [apiFetch, leagueId, owned])

  useEffect(() => {
    apiFetch<Record<string, Record<string, StatAvg> | null>>(`/api/leagues/${leagueId}/stats`)
      .then(setRanges)
      .catch(() => setRanges({}))
  }, [apiFetch, leagueId])

  const moveSlot = async (
    playerId: string,
    slot: 'active' | 'bench' | 'ir' | 'redshirt' | 'international' | 'drop'
  ) => {
    setBusy(true)
    try {
      const r = await apiFetch<{ capNotice?: string | null }>(`/api/leagues/${leagueId}/roster`, {
        method: 'POST',
        // Drops and redshirt moves are season acts, not daily lineup
        // moves — they carry no date.
        body: JSON.stringify(
          slot === 'drop' ||
          slot === 'redshirt' ||
          slot === 'international' ||
          ['redshirt', 'international'].includes(
            players?.find((p) => p.id === playerId)?.slot ?? ''
          )
            ? { playerId, slot }
            : { playerId, slot, date: selDate }
        ),
      })
      if (r?.capNotice) toast.warning(r.capNotice, { duration: 8000 })
      setOpenRow(null)
      setConfirmDrop(null)
      setConfirmRs(null)
      load()
      loadDay()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Move failed')
    } finally {
      setBusy(false)
    }
  }

  if (error) return <EmptyState title="Something went wrong">{error}</EmptyState>
  if (teams == null || players == null) {
    return (
      <div className="mns-page py-6 flex flex-col gap-2">
        <Skeleton h="2.2rem" w="55%" />
        <Skeleton h="3.4rem" />
        <Skeleton h="3.4rem" />
        <Skeleton h="3.4rem" />
      </div>
    )
  }

  if (!team) {
    return (
      <EmptyState title={teamId ? 'Team not found' : "You don't own a team here"}>
        {teamId
          ? 'That team is not in this league.'
          : 'Ask the commissioner to add you as an owner — the invite email links your account by address.'}
      </EmptyState>
    )
  }

  const roster = players
    .filter((p) => p.teamId === team.id)
    .sort((a, b) => (b.salary ?? 0) - (a.salary ?? 0))
  // Redshirts ride free against the cap and hold no roster spot.
  const capUsed = roster
    .filter((p) => COUNTS_AGAINST_CAP(p.slot))
    .reduce((n, p) => n + (p.salary ?? 0), 0)
  const mine = team.owners.some((o) => o.userId != null && o.userId === user?.id)

  // The 100% mark for the salary wash: the biggest salary anywhere in
  // the league pool.
  const salaryCeil = Math.max(1, ...players.map((p) => p.salary ?? 0))

  const today = etToday()
  const minDate = currentLeague?.config.season?.startDate ?? shiftDate(today, -7)
  const maxDate = shiftDate(today, 13)
  const isToday = selDate === today
  const locked = day ? day.locked : selDate < today
  // Crowned: the roster is a record to read, not a lineup to set.
  const offseason = currentLeague?.leaguePhase === 'champion'
  const editable = mine && !locked && !offseason
  // Tonight's lock is per player: once her game tips she stays where
  // she is until tomorrow. Future days never lock.
  const gameOf = (p: RosterPlayer) => (day && p.teamCode ? day.games[p.teamCode] : undefined)
  const rowLocked = (p: RosterPlayer) => isToday && playerLocked(gameOf(p))

  // The day's slot for each player — the daily lineup when loaded,
  // the base slot until then.
  const slotOf = (p: RosterPlayer) => day?.slots[p.id] ?? p.slot ?? 'active'
  const bySlot = (s: string) => roster.filter((p) => slotOf(p) === s)

  // Which named slot each active player is filling today, and what the
  // lineup still has open — the same matching the server enforces.
  // Declared AFTER slotOf: it calls it immediately, so it cannot sit
  // above the definition.
  const shape = currentLeague?.config.roster?.positionSlots ?? []
  const lineupFit = assignSlots(
    bySlot('active').map((p) => ({ id: p.id, position: p.position })),
    shape
  )

  const gameNote = (p: RosterPlayer) => {
    if (!day) return null
    const g = p.teamCode ? day.games[p.teamCode] : undefined
    const line = day.lines[p.id]
    if (isToday && playerLocked(g) && !line) {
      return (
        <span className="text-[var(--color-muted-foreground)]">
          <Lock aria-hidden className="inline w-3 h-3 mr-0.5 -mt-0.5" />
          locked · tipped {tipClock(g!.tip)}
        </span>
      )
    }
    if (line && (line.min > 0 || g?.state !== 'pre')) {
      return (
        <span className="text-[var(--color-accent)]">
          {line.pts}p {line.reb}r {line.ast}a{line.stl ? ` ${line.stl}s` : ''}
          {line.blk ? ` ${line.blk}b` : ''} · {line.min} min
        </span>
      )
    }
    if (!g) {
      return <span className="text-[var(--color-muted-foreground)]">no game</span>
    }
    return (
      <span className="text-[var(--color-foreground)]">
        {g.home ? 'vs' : '@'} {g.opp}
        {g.state === 'pre' ? ` · ${fmtTip(g.tip)}` : g.state === 'in' ? ' · live' : ' · final'}
      </span>
    )
  }

  // Keeper season: the owner's team page IS the keeper planner. Other
  // owners see the roster as usual — decisions are private until the lock.
  if (mine && currentLeague?.leaguePhase === 'keeper_season') {
    return <KeeperPlanner leagueId={leagueId} teamName={team.name} logo={team.logo} />
  }
  return (
    <div className="mns-page py-2 pb-24">
      <div className="relative">
        <PageHeader
          back={`/league/${leagueId}`}
          backLabel="League home"
          eyebrow={mine ? 'My team' : 'Team'}
          title={
            <span className="flex items-center gap-3">
              {team.logo ? (
                <img
                  src={team.logo}
                  alt=""
                  className="w-14 h-14 rounded-xl object-cover shrink-0"
                />
              ) : null}
              <span className="min-w-0">{team.name}</span>
            </span>
          }
          status={`${team.owners.map((o) => o.displayName ?? o.email.split('@')[0]).join(' · ') || 'No owner yet'} · ${roster.length} players · $${capUsed.toLocaleString()} cap`}
        />
        <div className="absolute right-0 top-6 flex items-center gap-2">
          {mine ? (
            <Button
              variant="quiet"
              aria-label="Team settings"
              aria-expanded={showSettings}
              onClick={() => setShowSettings(!showSettings)}
            >
              <Settings aria-hidden />
            </Button>
          ) : null}
        </div>
      </div>

      {/* Desktop parks settings in a right column so the roster stays in
          view while you edit; phones keep it above the roster as before.
          The two wrappers close just before the page's closing div. */}
      <div className={mine && showSettings ? 'lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-6 lg:items-start' : ''}>
      {mine && showSettings ? (
        <aside className="lg:order-2 lg:sticky lg:top-4">
          <TeamSettings leagueId={leagueId} team={team} onSaved={() => { setShowSettings(false); load() }} />
        </aside>
      ) : null}
      <div className="min-w-0 lg:order-1">
      {currentLeague?.config.cap?.enabled ? (
        <CardCarousel pane={pane} onPane={setPane}>
          <CapCard
            capUsed={capUsed}
            cap={currentLeague.config.cap}
            fees={{ ...currentLeague.config.fees, penaltyRatePerM: penaltyRate(currentLeague.config) }}
            dues={fees?.dues ?? null}
          />
          <FeesCard fees={fees} />
        </CardCarousel>
      ) : null}

      {(() => {
        const activeSize = currentLeague?.config.roster?.activeSize ?? 10
        const nonIr = roster.filter((p) => HOLDS_ROSTER_SPOT(p.slot ?? 'active')).length
        return mine && nonIr > activeSize ? (
          <div className="mb-4 rounded-lg border border-[var(--color-pick-loss,#ff453a)] bg-mns-card p-3 text-sm">
            <b className="text-[var(--color-pick-loss,#ff453a)]">
              Roster over the limit — {nonIr} players for {activeSize} spots.
            </b>{' '}
            That trade came with homework: drop someone, or move an injured player to IR (IR
            doesn&rsquo;t hold a spot). Adds and claims are frozen until you&rsquo;re legal.
          </div>
        ) : null
      })()}

      {mine && claims.length > 0 ? (
        <div className="mb-4 rounded-lg border border-[var(--color-accent)] bg-mns-card p-3 text-sm">
          <b>Waiver queue in</b> — clears {claims[0].clearsOn} at 8am ET, snake order
          <ol className="mt-1 list-decimal list-inside tabular-nums">
            {claims.map((c) => (
              <li key={c.id}>
                {c.addNames.join(' → ')}
                {c.dropName ? (
                  <span className="text-[var(--color-muted-foreground)]"> · drop {c.dropName}</span>
                ) : null}
              </li>
            ))}
          </ol>
          <Link
            to={`/league/${leagueId}/free-agents`}
            className="mt-1 inline-block font-bold text-[var(--color-accent)]"
          >
            Reorder or withdraw →
          </Link>
        </div>
      ) : null}

      {/* The day carousel: yesterday is history, tomorrow is a plan.
          Phones step one day at a time; desktops see the week around
          the selected day and click straight to it. */}
      <div className="mb-4 flex items-center gap-2 lg:justify-center">
        <Button
          variant="quiet"
          aria-label="Previous day"
          disabled={selDate <= minDate}
          onClick={() => { setSelDate(shiftDate(selDate, -1)); setOpenRow(null); setConfirmDrop(null) }}
        >
          <ChevronLeft aria-hidden />
        </Button>
        <div className="flex-1 text-center lg:hidden">
          <div className="font-bold">{fmtDay(selDate)}</div>
          <div className="text-xs text-[var(--color-muted-foreground)]">
            {offseason ? 'Season complete — rosters reopen next season' : isToday ? 'Today' : locked ? 'Locked — this day is done' : 'Sets automatically on the day'}
          </div>
        </div>
        <div className="hidden lg:flex gap-1.5">
          {[-3, -2, -1, 0, 1, 2, 3].map((off) => {
            const d = shiftDate(selDate, off)
            const dt = new Date(`${d}T00:00:00Z`)
            const current = d === selDate
            return (
              <button
                key={d}
                type="button"
                disabled={d < minDate || d > maxDate}
                aria-current={current ? 'date' : undefined}
                onClick={() => { setSelDate(d); setOpenRow(null); setConfirmDrop(null) }}
                className={
                  'min-w-[4.5rem] rounded-lg border px-2 py-1.5 leading-tight transition-colors disabled:opacity-25 ' +
                  (current
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-foreground)]'
                    : d < today
                      ? 'border-[var(--color-border)] text-[var(--color-muted-foreground)] opacity-60 hover:opacity-100'
                      : 'border-[var(--color-border)] text-[var(--color-muted-foreground)] hover:border-[var(--color-accent)] hover:text-[var(--color-foreground)]')
                }
              >
                <div className="text-[0.65rem] font-bold uppercase tracking-wider">
                  {d === today ? 'Today' : dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}
                </div>
                <div className="text-sm font-bold tabular-nums">
                  {dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}
                </div>
              </button>
            )
          })}
        </div>
        <Button
          variant="quiet"
          aria-label="Next day"
          disabled={selDate >= maxDate}
          onClick={() => { setSelDate(shiftDate(selDate, 1)); setOpenRow(null); setConfirmDrop(null) }}
        >
          <ChevronRight aria-hidden />
        </Button>
        {!isToday ? (
          <Button variant="quiet" onClick={() => { setSelDate(today); setOpenRow(null); setConfirmDrop(null) }}>
            Today
          </Button>
        ) : null}
      </div>
      <p className="hidden lg:block -mt-2 mb-4 text-center text-xs text-[var(--color-muted-foreground)]">
        {offseason ? 'Season complete — rosters reopen next season' : isToday ? 'Today' : locked ? 'Locked — this day is done' : 'Sets automatically on the day'}
      </p>
      <div className="mb-4 flex justify-end">
        <RangeChips value={range} onChange={setRange} hasLastSeason={!!ranges?.lastSeason} />
      </div>

      <PlayerCard leagueId={leagueId} playerId={cardId} ranges={ranges} onClose={() => setCardId(null)} />

      {/* Desktop: the scoring slots run full width; the parked lists and
          draft capital share the row beneath them. */}
      <div className="lg:grid lg:grid-cols-2 lg:gap-x-6">
      {roster.length === 0 ? (
        <div className="lg:col-span-2">
          <EmptyState title="No players yet">
            The roster fills from the draft, waivers and trades.
          </EmptyState>
        </div>
      ) : (
        <>
          {(
            [
              ['active', 'Active — these score', bySlot('active')],
              ['bench', 'Bench — not scoring', bySlot('bench')],
              ['ir', 'IR — not scoring, no roster spot', bySlot('ir')],
              ['redshirt', 'Redshirt — no spot, no cap hit', bySlot('redshirt')],
              ['international', 'International — stashed abroad', bySlot('international')],
            ] as const
          ).map(([slotKey, label, list]) =>
            slotKey === 'active' ||
            list.length > 0 ||
            (mine && slotKey !== 'redshirt' && slotKey !== 'international') ? (
              <section
                key={slotKey}
                className={slotKey === 'redshirt' || slotKey === 'international' ? 'mb-5' : 'mb-5 lg:col-span-2'}
              >
                <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--color-muted-foreground)] mb-2">
                  {label} ({list.length})
                  {slotKey === 'active' && shape.length > 0 && lineupFit.openSlots.length > 0 ? (
                    <span className="ml-2 normal-case tracking-normal font-normal text-[var(--color-key,#ffb000)]">
                      open: {lineupFit.openSlots.join(', ')}
                    </span>
                  ) : null}
                </h2>
                {list.length === 0 ? (
                  <p className="text-sm text-[var(--color-muted-foreground)]">Empty.</p>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-mns-card">
                    <table className="w-full text-sm tabular-nums whitespace-nowrap">
                      <thead>
                        <tr className="border-b border-[var(--color-border)]">
                          {editable ? <th className="sticky left-0 bg-mns-card w-8 p-0" /> : null}
                          <th
                            className={
                              'sticky bg-mns-card text-left text-xs font-bold text-[var(--color-muted-foreground)] px-2 py-2 ' +
                              (editable ? 'left-8' : 'left-0')
                            }
                          >
                            Player
                          </th>
                          {(
                            [
                              ['ppg', 'PTS'],
                              ['rpg', 'REB'],
                              ['apg', 'AST'],
                              ['spg', 'STL'],
                              ['bpg', 'BLK'],
                              ['tpg', '3PM'],
                              ['fgPct', 'FG%'],
                              ['cat', 'CAT'],
                              ['catD', 'CAT$'],
                              ['gp', 'GP'],
                              ['salary', '$'],
                            ] as const
                          ).map(([k, h]) => (
                            <th key={k} className="p-0">
                              <button
                                onClick={() => {
                                  if (sortBy === k) setAsc(!asc)
                                  else {
                                    setSortBy(k)
                                    setAsc(false)
                                  }
                                }}
                                aria-pressed={sortBy === k}
                                className={
                                  'w-full min-h-[2.5rem] px-2 text-right text-xs font-bold ' +
                                  (sortBy === k
                                    ? 'text-[var(--color-accent)]'
                                    : 'text-[var(--color-muted-foreground)]')
                                }
                              >
                                {h}
                                {sortBy === k ? (asc ? ' ↑' : ' ↓') : ''}
                              </button>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {[...list]
                          .sort((a, b) => {
                            const v = (p: RosterPlayer) =>
                              sortBy === 'salary'
                                ? p.salary ?? 0
                                : (ranges?.[range]?.[p.id]?.[sortBy] as number | null | undefined) ?? -99
                            return (asc ? 1 : -1) * (v(a) - v(b))
                          })
                          .map((p) => {
                            const a = ranges?.[range]?.[p.id]
                            const open = openRow === p.id
                            return (
                              <Fragment key={p.id}>
                                <tr className="border-b border-[var(--color-border)] last:border-b-0">
                                  {editable ? (
                                    <td className="sticky left-0 bg-mns-card w-8 px-1">
                                      <button
                                        aria-label={open ? `Close actions for ${p.name}` : `Move ${p.name}`}
                                        aria-expanded={open}
                                        onClick={() => {
                                          setOpenRow(open ? null : p.id)
                                          setConfirmDrop(null)
                                        }}
                                        className="min-h-[2.75rem] px-1 text-[var(--color-muted-foreground)]"
                                      >
                                        {open ? (
                                          <X aria-hidden className="w-4 h-4" />
                                        ) : (
                                          <EllipsisVertical aria-hidden className="w-4 h-4" />
                                        )}
                                      </button>
                                    </td>
                                  ) : null}
                                  <td
                                    className={
                                      'sticky bg-mns-card px-2 py-1.5 max-w-[10rem] relative isolate ' +
                                      (editable ? 'left-8' : 'left-0')
                                    }
                                  >
                                    {p.salary != null ? (
                                      <span
                                        aria-hidden
                                        className="absolute inset-y-0 left-0 -z-10 pointer-events-none"
                                        style={{
                                          width: `${Math.max(2, ((p.salary ?? 0) / salaryCeil) * 100)}%`,
                                          background:
                                            'linear-gradient(to right, color-mix(in srgb, var(--color-accent) 18%, transparent) 70%, transparent)',
                                        }}
                                      />
                                    ) : null}
                                    {isFreshNews(p.injuryUpdatedAt, p.injuryStatus) ? (
                                      <span
                                        aria-hidden
                                        className="absolute top-0 left-0"
                                        style={{
                                          borderTop: '7px solid var(--color-key, #ffb000)',
                                          borderRight: '7px solid transparent',
                                        }}
                                      />
                                    ) : null}
                                    <button
                                      onClick={() => setCardId(p.id)}
                                      className="block w-full text-left"
                                      aria-label={`Open ${p.name}'s card`}
                                    >
                                      <span className="block font-semibold truncate">
                                        <PlayerName name={p.name} injuryStatus={p.injuryStatus} />
                                        {p.isRookie ? (
                                          <span className="ml-1"><Chip tone="accent">R</Chip></span>
                                        ) : null}
                                      </span>
                                      <span className="block text-xs text-[var(--color-muted-foreground)] truncate">
                                        {shape.length > 0 && slotKey === 'active' && lineupFit.assignment.get(p.id) ? (
                                          <b className="text-[var(--color-accent)]">
                                            {lineupFit.assignment.get(p.id)}{' '}
                                          </b>
                                        ) : null}
                                        {[p.position, p.teamCode].filter(Boolean).join(' · ')}
                                        {day ? <> — {gameNote(p)}</> : null}
                                      </span>
                                    </button>
                                  </td>
                                  <td className="px-2 text-right font-semibold">{a?.ppg ?? '—'}</td>
                                  <td className="px-2 text-right">{a?.rpg ?? '—'}</td>
                                  <td className="px-2 text-right">{a?.apg ?? '—'}</td>
                                  <td className="px-2 text-right">{a?.spg ?? '—'}</td>
                                  <td className="px-2 text-right">{a?.bpg ?? '—'}</td>
                                  <td className="px-2 text-right">{a?.tpg ?? '—'}</td>
                                  <td className="px-2 text-right">{a?.fgPct != null ? `${a.fgPct}%` : '—'}</td>
                                  <td className="px-2 text-right font-semibold">{a?.cat != null ? a.cat.toFixed(2) : '—'}</td>
                                  <td className="px-2 text-right font-semibold">{a?.catD != null ? a.catD.toFixed(2) : '—'}</td>
                                  <td className="px-2 text-right">{a?.gp ?? 0}</td>
                                  <td className="px-2 text-right text-[var(--color-muted-foreground)]">
                                    {p.salary != null ? fmtM(p.salary) : '—'}
                                  </td>
                                </tr>
                                {editable && open && rowLocked(p) ? (
                                  <tr className="border-b border-[var(--color-border)] last:border-b-0">
                                    <td colSpan={13} className="px-2 py-2 text-sm text-[var(--color-muted-foreground)]">
                                      <Lock aria-hidden className="inline w-4 h-4 mr-1 -mt-0.5" />
                                      Locked — game tipped at {tipClock(gameOf(p)!.tip)} ET. Back in play tomorrow.
                                    </td>
                                  </tr>
                                ) : null}
                                {editable && open && !rowLocked(p) ? (
                                  <tr className="border-b border-[var(--color-border)] last:border-b-0">
                                    <td colSpan={13} className="px-2 py-1.5">
                                      <div className="flex flex-wrap gap-1.5 justify-start">
                                        {slotKey === 'international' ? (
                                          <Button
                                            variant="quiet"
                                            onClick={() => moveSlot(p.id, 'active')}
                                            disabled={busy}
                                          >
                                            Return
                                          </Button>
                                        ) : slotKey === 'redshirt' ? (
                                          <Button
                                            variant={confirmRs === p.id ? 'danger' : 'quiet'}
                                            onClick={() =>
                                              confirmRs === p.id
                                                ? moveSlot(p.id, 'active')
                                                : setConfirmRs(p.id)
                                            }
                                            disabled={busy}
                                          >
                                            {confirmRs === p.id
                                              ? `Activate — $${currentLeague?.config.fees?.activationFee ?? 0} fee, redshirt spent`
                                              : 'Activate'}
                                          </Button>
                                        ) : slotKey !== 'active' ? (
                                          <Button variant="quiet" onClick={() => moveSlot(p.id, 'active')} disabled={busy}>
                                            Start
                                          </Button>
                                        ) : null}
                                        {slotKey !== 'bench' && slotKey !== 'redshirt' ? (
                                          <Button variant="quiet" onClick={() => moveSlot(p.id, 'bench')} disabled={busy}>
                                            Bench
                                          </Button>
                                        ) : null}
                                        {slotKey !== 'ir' && slotKey !== 'redshirt' ? (
                                          <Button variant="quiet" onClick={() => moveSlot(p.id, 'ir')} disabled={busy}>
                                            IR
                                          </Button>
                                        ) : null}
                                        {currentLeague?.config.roster?.intStashAllowed &&
                                        slotKey !== 'international' &&
                                        (p.presenceOverride ?? p.leaguePresence) !== 'rostered' &&
                                        !(ranges?.season?.[p.id]?.gp ?? 0) ? (
                                          // Off a redshirt, a stash is still an exit: it costs
                                          // the activation fee and spends the redshirt, so it
                                          // goes through the same confirm.
                                          <Button
                                            variant={slotKey === 'redshirt' && confirmRs === `${p.id}:stash` ? 'danger' : 'quiet'}
                                            onClick={() =>
                                              slotKey !== 'redshirt'
                                                ? moveSlot(p.id, 'international')
                                                : confirmRs === `${p.id}:stash`
                                                  ? moveSlot(p.id, 'international')
                                                  : setConfirmRs(`${p.id}:stash`)
                                            }
                                            disabled={busy}
                                          >
                                            {slotKey === 'redshirt' && confirmRs === `${p.id}:stash`
                                              ? `Stash — $${currentLeague?.config.fees?.activationFee ?? 0} fee, redshirt spent`
                                              : 'Stash'}
                                          </Button>
                                        ) : null}
                                        {currentLeague?.config.roster?.redshirtsAllowed &&
                                        slotKey !== 'redshirt' &&
                                        (p.yearsPro != null ? p.yearsPro === 0 : p.isRookie) &&
                                        (p.presenceOverride ?? p.leaguePresence) === 'rostered' &&
                                        !p.redshirtUsed &&
                                        !(ranges?.season?.[p.id]?.gp ?? 0) ? (
                                          <Button
                                            variant={confirmRs === p.id ? 'danger' : 'quiet'}
                                            onClick={() =>
                                              confirmRs === p.id
                                                ? moveSlot(p.id, 'redshirt')
                                                : setConfirmRs(p.id)
                                            }
                                            disabled={busy}
                                          >
                                            {confirmRs === p.id
                                              ? `Confirm — $${currentLeague?.config.fees?.redshirtFee ?? 0} fee`
                                              : 'Redshirt'}
                                          </Button>
                                        ) : null}
                                        {isToday ? (
                                          <Button
                                            variant={confirmDrop === p.id ? 'danger' : 'quiet'}
                                            onClick={() =>
                                              confirmDrop === p.id ? moveSlot(p.id, 'drop') : setConfirmDrop(p.id)
                                            }
                                            disabled={busy}
                                          >
                                            {confirmDrop === p.id ? `Confirm drop ${p.name.split(' ').pop()}` : 'Drop'}
                                          </Button>
                                        ) : null}
                                      </div>
                                    </td>
                                  </tr>
                                ) : null}
                              </Fragment>
                            )
                          })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ) : null
          )}
        </>
      )}

      {/* Draft capital is roster truth too — the picks this team can
          deal or use, three drafts out. */}
      {(team.picks ?? []).length > 0 ? (
        <section className="mb-5">
          <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--color-muted-foreground)] mb-2">
            Rookie draft picks ({team.picks!.length})
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {[...team.picks!]
              .sort((a, b) => a.seasonYear - b.seasonYear || a.round - b.round)
              .map((pk) => (
                <span
                  key={pk.id}
                  className="text-sm rounded-full px-3 py-1.5 border border-[var(--color-border)] tabular-nums"
                >
                  {pk.seasonYear} Rd {pk.round}
                  {pk.originalTeamId !== team.id ? (
                    <span className="text-[var(--color-accent)]"> via {pk.originalTeamName}</span>
                  ) : null}
                </span>
              ))}
          </div>
          {mine ? (
            <p className="mt-1.5 text-xs text-[var(--color-muted-foreground)]">
              Picks trade like players — deal them in the Trade Machine.
            </p>
          ) : null}
        </section>
      ) : null}
      </div>
      </div>
      </div>
    </div>
  )
}

// Your team, your look: rename it, give it a logo, add a co-owner.
// The logo is resized in the browser to a small data URL — no file
// storage to configure, and 256px is plenty for a crest.
function TeamSettings({
  leagueId,
  team,
  onSaved,
}: {
  leagueId: string
  team: TeamInfo
  onSaved: () => void
}) {
  const { apiFetch } = useApi()
  const { user } = useUser()
  const myOwnerRow = team.owners.find((o) => o.userId != null && o.userId === user?.id)
  const [prefs, setPrefs] = useState<Record<string, boolean>>(myOwnerRow?.emailPrefs ?? {})
  const [name, setName] = useState(team.name)
  const [ai, setAi] = useState<Record<string, unknown>>(team.aiPrefs ?? {})
  const [aiDirty, setAiDirty] = useState(false)
  const [logo, setLogo] = useState<string | null | undefined>(undefined) // undefined = unchanged
  const [coOwner, setCoOwner] = useState('')
  const [saving, setSaving] = useState(false)

  const pickFile = (file: File | null) => {
    if (!file) return
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const max = 256
      const scale = Math.min(1, max / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      // WebP keeps transparency small; a browser that can't encode it
      // falls back to PNG.
      let data = canvas.toDataURL('image/webp', 0.85)
      if (!data.startsWith('data:image/webp')) data = canvas.toDataURL('image/png')
      if (data.length > 300_000) {
        toast.error('That image is too detailed — try a simpler one.')
        return
      }
      setLogo(data)
    }
    img.onerror = () => toast.error('Could not read that image.')
    img.src = url
  }

  // Prefs save quietly in place — the panel stays open for the next
  // toggle.
  const savePrefs = async (next: Record<string, boolean>) => {
    try {
      await apiFetch(`/api/leagues/${leagueId}/teams`, {
        method: 'PATCH',
        body: JSON.stringify({ teamId: team.id, emailPrefs: next }),
      })
      toast.success('Email preferences saved')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    }
  }

  const save = async (body: Record<string, unknown>, okMsg: string) => {
    setSaving(true)
    try {
      await apiFetch(`/api/leagues/${leagueId}/teams`, {
        method: 'PATCH',
        body: JSON.stringify({ teamId: team.id, ...body }),
      })
      toast.success(okMsg)
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const preview = logo === undefined ? team.logo : logo

  return (
    <div className="mb-5 rounded-lg border border-[var(--color-border-interactive)] bg-mns-card p-4 flex flex-col gap-4 text-sm">
      <div>
        <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1.5" htmlFor="team-name">
          Team name
        </label>
        <div className="flex gap-2">
          <input
            id="team-name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 min-w-0 px-3 py-2 min-h-[3rem] rounded-lg bg-[var(--color-background)] border border-[var(--color-border-interactive)] text-[var(--color-foreground)] focus:outline-none focus:border-[var(--color-accent)]"
          />
          <Button onClick={() => save({ name }, 'Team renamed')} disabled={saving || !name.trim() || name.trim() === team.name}>
            Save
          </Button>
        </div>
      </div>

      <div>
        <span className="block text-xs font-bold uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1.5">
          Logo
        </span>
        <div className="flex items-center gap-3">
          {preview ? (
            <img src={preview} alt="Team logo preview" className="w-16 h-16 rounded-full object-cover" />
          ) : (
            <span className="w-16 h-16 rounded-full border border-dashed border-[var(--color-border-interactive)] flex items-center justify-center text-xs text-[var(--color-muted-foreground)]">
              none
            </span>
          )}
          <label className="inline-flex items-center px-4 min-h-[3rem] rounded-lg border border-[var(--color-border-interactive)] cursor-pointer font-semibold">
            Choose image
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
          </label>
          {logo !== undefined ? (
            <Button onClick={() => save({ logo }, 'Logo saved')} disabled={saving}>
              Save logo
            </Button>
          ) : team.logo ? (
            <Button variant="quiet" onClick={() => save({ logo: null }, 'Logo removed')} disabled={saving}>
              Remove
            </Button>
          ) : null}
        </div>
      </div>

      <div>
        <span className="block text-xs font-bold uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1.5">
          Bump's read on this team
        </span>
        <p className="text-xs text-[var(--color-muted-foreground)] mb-2">
          Set the dials and Bump tailors every suggestion — trades, pickups, keepers — to how YOU
          run this team. Private to your team; other owners get their own advice.
        </p>
        <StrategyDials
          value={ai}
          onChange={(next) => {
            setAi(next)
            setAiDirty(true)
          }}
          dirty={aiDirty}
          saving={saving}
          onSave={() => {
            setAiDirty(false)
            void save({ aiPrefs: ai }, "Saved — Bump's advice follows your dials now")
          }}
        />
      </div>

      <div>
        <span className="block text-xs font-bold uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1.5">
          Email me about
        </span>
        <div className="flex flex-col gap-1.5">
          {(
            [
              ['waivers', 'Waiver results — what cleared at 8am'],
              ['trades', 'Trade offers and answers'],
              ['lineup', 'Lineup warnings — OUT players before tip'],
              ['fees', 'Fee receipts — cap dues when they book'],
            ] as const
          ).map(([k, label]) => {
            const on = prefs[k] !== false
            return (
              <label key={k} className="flex items-center gap-2.5 min-h-[2.5rem] cursor-pointer text-sm">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => {
                    const next = { ...prefs, [k]: !on }
                    setPrefs(next)
                    void savePrefs(next)
                  }}
                  className="w-5 h-5 accent-[var(--color-accent)]"
                />
                {label}
              </label>
            )
          })}
        </div>
        <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
          Just you — co-owners choose for themselves.
        </p>
      </div>

      <div>
        <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-muted-foreground)] mb-1.5" htmlFor="co-owner">
          Add a co-owner
        </label>
        <div className="flex gap-2">
          <input
            id="co-owner"
            type="email"
            value={coOwner}
            placeholder="their@email.com"
            onChange={(e) => setCoOwner(e.target.value)}
            className="flex-1 min-w-0 px-3 py-2 min-h-[3rem] rounded-lg bg-[var(--color-background)] border border-[var(--color-border-interactive)] text-[var(--color-foreground)] placeholder:text-[var(--color-muted-foreground)] focus:outline-none focus:border-[var(--color-accent)]"
          />
          <Button
            onClick={() => { save({ addOwnerEmail: coOwner.trim() }, 'Co-owner invited'); setCoOwner('') }}
            disabled={saving || !coOwner.includes('@')}
          >
            Invite
          </Button>
        </div>
        <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
          They get an email; signing in with that address links them to this team.
        </p>
      </div>
    </div>
  )
}

// Two cards, one space: the cap picture by default, the league's fee
// sheet a swipe away — the legacy app's carousel. Scroll-snap does the
// swiping natively, and the dots double as buttons for anyone on a
// mouse or a keyboard. From desktop width both cards simply sit side
// by side and the carousel chrome disappears.
function CardCarousel({
  pane,
  onPane,
  children,
}: {
  pane: number
  onPane: (i: number) => void
  children: React.ReactNode[]
}) {
  const ref = useRef<HTMLDivElement>(null)
  const panes = React.Children.toArray(children)

  const go = (i: number) => {
    onPane(i)
    const el = ref.current
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' })
  }

  const arrow = (dir: -1 | 1) => {
    const target = pane + dir
    const disabled = target < 0 || target >= panes.length
    return (
      <button
        onClick={() => go(target)}
        disabled={disabled}
        aria-label={dir < 0 ? 'Previous card' : 'Next card'}
        // Phones swipe; desktops get the arrows they expect, parked
        // outside the card so nothing covers its numbers.
        className="hidden sm:inline-flex lg:hidden shrink-0 items-center justify-center w-9 h-9 rounded-full border border-[var(--color-border-interactive)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] hover:border-[var(--color-accent)] disabled:opacity-25 disabled:hover:border-[var(--color-border-interactive)] disabled:hover:text-[var(--color-muted-foreground)] transition-colors"
      >
        {dir < 0 ? (
          <ChevronLeft aria-hidden className="w-5 h-5" />
        ) : (
          <ChevronRight aria-hidden className="w-5 h-5" />
        )}
      </button>
    )
  }

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2">
        {arrow(-1)}
        <div
          ref={ref}
          onScroll={(e) => {
            const el = e.currentTarget
            const i = Math.round(el.scrollLeft / Math.max(1, el.clientWidth))
            if (i !== pane) onPane(i)
          }}
          className="flex-1 min-w-0 flex overflow-x-auto snap-x snap-mandatory scrollbar-none lg:grid lg:grid-cols-2 lg:gap-4 lg:overflow-visible"
          style={{ scrollbarWidth: 'none' }}
        >
          {panes.map((child, i) => (
            <div key={i} className="min-w-full snap-center lg:min-w-0">
              {child}
            </div>
          ))}
        </div>
        {arrow(1)}
      </div>
      <div className="flex justify-center gap-2 -mt-2 lg:hidden">
        {panes.map((_, i) => (
          <button
            key={i}
            onClick={() => go(i)}
            aria-label={i === 0 ? 'Salary cap' : 'Roster and fees'}
            aria-current={pane === i}
            className="p-2"
          >
            <span
              className="block w-2 h-2 rounded-full"
              style={{
                background:
                  pane === i ? 'var(--color-accent)' : 'var(--color-border-interactive)',
              }}
            />
          </button>
        ))}
      </div>
    </div>
  )
}

// Roster summary and fees due — tracked, never handled.
function FeesCard({ fees }: { fees: FeesPayload | null }) {
  const usd = (n: number) => `$${n.toLocaleString('en-US')}`
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-mns-card p-4">
      <span className="block text-sm font-bold uppercase tracking-wider text-[var(--color-muted-foreground)] mb-3">
        Roster &amp; fees
      </span>
      {!fees ? (
        <Skeleton h="6rem" />
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2 mb-3 text-center tabular-nums">
            {(
              [
                ['Roster', `${fees.roster.used} / ${fees.roster.size}`],
                ['Redshirts', String(fees.roster.redshirts)],
                ['Int stash', String(fees.roster.intStash)],
                ['IR', String(fees.roster.ir)],
              ] as const
            ).map(([label, value]) => (
              <span key={label}>
                <b className="block text-lg leading-tight">{value}</b>
                <span className="block text-[0.68rem] uppercase tracking-wider text-[var(--color-muted-foreground)]">
                  {label}
                </span>
              </span>
            ))}
          </div>
          {fees.lines.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">Nothing due yet.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm tabular-nums">
              {fees.lines.map((l) => (
                <li key={l.label} className="flex items-baseline justify-between gap-3">
                  <span>
                    {l.label}
                    {l.note ? (
                      <span className="text-[var(--color-muted-foreground)]"> ({l.note})</span>
                    ) : null}
                  </span>
                  <span>{usd(l.amount)}</span>
                </li>
              ))}
              <li className="flex items-baseline justify-between gap-3 border-t border-[var(--color-border)] mt-1 pt-1">
                <b>Total fees</b>
                <b>{usd(fees.total)}</b>
              </li>
            </ul>
          )}
          <p className="mt-2 text-[0.68rem] text-[var(--color-muted-foreground)]">
            The commissioner collects — this page keeps the tally.
          </p>
        </>
      )}
    </div>
  )
}
