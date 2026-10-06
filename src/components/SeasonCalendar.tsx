import { useEffect, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { Banner } from '../ui/components'

interface CalendarWeek {
  week: number
  startDate: string
  endDate: string
  games: number
  avgPerTeam: number
  teamsLight: number
  zeroDays: string[]
  playoff: boolean
}
interface Suggestion {
  kind: 'combine' | 'no_games'
  calendarWeeks: number[]
  label: string
  reason: string
}
interface Payload {
  startDate: string
  regularWeeks: number
  playoffWeeks: number
  coveredThrough: string | null
  weeks: CalendarWeek[]
  suggestions: Suggestion[]
}
export type CombinedWeek = { calendarWeeks: number[]; label: string }

const fmt = (d: string) => {
  const [, m, day] = d.split('-')
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${Number(day)}`
}
const sameWeeks = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i])

// The season as the league will play it: every week with the real
// number of games per club from the sport's schedule, light weeks
// marked, and the folds the schedule suggests as one-tap toggles. The
// commissioner decides; the generator does the rest at Start the
// season.
export function SeasonCalendar({
  leagueId,
  startDate,
  weeks,
  playoffWeeks,
  combined,
  onChange,
}: {
  leagueId: string
  startDate: string
  weeks: number
  playoffWeeks: number
  combined: CombinedWeek[]
  onChange: (next: CombinedWeek[]) => void
}) {
  const { apiFetch } = useApi()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !(weeks > 0)) return
    let cancelled = false
    apiFetch<Payload>(
      `/api/leagues/${leagueId}/season-calendar?startDate=${startDate}&weeks=${weeks}&playoffWeeks=${playoffWeeks}`
    )
      .then((d) => {
        if (!cancelled) {
          setData(d)
          setError(null)
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [apiFetch, leagueId, startDate, weeks, playoffWeeks])

  if (error) return <p className="text-sm text-[var(--color-muted-foreground)]">{error}</p>
  if (!data) return null
  const known = data.weeks.filter((w) => w.games > 0)
  if (known.length === 0) {
    return (
      <p className="text-sm text-[var(--color-muted-foreground)]">
        The {data.coveredThrough ? 'schedule past ' + fmt(data.coveredThrough) : 'schedule'} hasn&rsquo;t been pulled
        yet — the calendar fills in within the hour.
      </p>
    )
  }
  const median = [...known.map((w) => w.avgPerTeam)].sort((a, b) => a - b)[Math.floor(known.length / 2)]
  const isOn = (s: Suggestion) => combined.some((c) => sameWeeks(c.calendarWeeks, s.calendarWeeks))
  const toggle = (s: Suggestion) =>
    onChange(
      isOn(s)
        ? combined.filter((c) => !sameWeeks(c.calendarWeeks, s.calendarWeeks))
        : [...combined, { calendarWeeks: s.calendarWeeks, label: s.label }]
    )
  const foldedInto = (week: number) => combined.find((c) => c.calendarWeeks.includes(week))
  const warnings = data.suggestions.filter((s) => s.kind === 'no_games')
  const folds = data.suggestions.filter((s) => s.kind === 'combine')

  return (
    <div className="mt-2">
      {warnings.map((s) => (
        <div key={s.label} className="mb-3">
          <Banner tone="warn">
            <b>{s.label}.</b> {s.reason}
          </Banner>
        </div>
      ))}
      {folds.length > 0 ? (
        <div className="mb-3 flex flex-col gap-2">
          {folds.map((s) => (
            <label
              key={s.label}
              className="flex items-start gap-2.5 min-h-[2.5rem] cursor-pointer rounded-lg border border-[var(--color-border)] bg-mns-card px-3 py-2 text-sm"
            >
              <input type="checkbox" className="mt-1" checked={isOn(s)} onChange={() => toggle(s)} />
              <span>
                <b>{s.label}</b>
                <span className="block text-[var(--color-muted-foreground)]">{s.reason}</span>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="mb-3 text-sm text-[var(--color-accent)]">
          No light weeks in this span — every week has a normal slate.
        </p>
      )}
      <div className="rounded-lg border border-[var(--color-border)] bg-mns-card divide-y divide-[var(--color-border)] text-sm">
        {data.weeks.map((w) => {
          const light = w.games > 0 && w.avgPerTeam < median * 0.7
          const fold = foldedInto(w.week)
          return (
            <div
              key={w.week}
              className="flex items-center gap-3 px-3 py-1.5 tabular-nums"
              style={w.games === 0 ? { color: 'var(--color-pick-loss, #ff453a)' } : light ? { color: 'var(--color-key, #ffb000)' } : undefined}
            >
              <span className="w-10 shrink-0 font-semibold">{w.playoff ? 'PO' : `Wk ${w.week}`}</span>
              <span className="w-28 shrink-0">
                {fmt(w.startDate)} – {fmt(w.endDate)}
              </span>
              <span className="flex-1 min-w-0 truncate">
                {w.games === 0
                  ? 'no games'
                  : `${w.avgPerTeam} games per club${w.zeroDays.length ? ` · ${w.zeroDays.length} dark day${w.zeroDays.length === 1 ? '' : 's'}` : ''}`}
                {fold ? <span className="ml-2 text-[var(--color-accent)]">folded</span> : null}
              </span>
            </div>
          )
        })}
      </div>
      <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
        Games per club from ESPN&rsquo;s schedule, refreshed weekly. A week under 70% of a normal week is marked light; a
        folded pair plays as one matchup. Folds apply when the season starts.
      </p>
    </div>
  )
}
