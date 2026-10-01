import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Trophy } from 'lucide-react'
import { useApi } from '../hooks/useApi'
import { Button, EmptyState, PageHeader, Skeleton } from '../ui/components'

interface PrizesPayload {
  potUsd: number
  totalUsd: number
  configured: boolean
  isCommissioner: boolean
  wallet: {
    address: string
    ethBalance: number | null
    ethPrice: number | null
    usdValue: number | null
    lastUpdated: string | null
    error: string | null
    baselineUsd?: number | null
    baselineAt?: string | null
    gainPct?: number | null
  } | null
  splits: Array<{ label: string; share: number; amountUsd: number; holder: string | null }>
  // Present once the season is crowned: the record is frozen.
  final?: {
    at: string
    seasonYear: number
    champion: { teamId: string; name: string } | null
    runnerUp: { teamId: string; name: string } | null
  }
}

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n >= 1000 ? 0 : 2 })
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

// The prize pool: what the pot is worth, what each place pays, who
// holds it right now. TRACKED, never handled — the commissioner holds
// and pays the pot however the league always has; no money moves
// through the app. A wallet here is a public address being WATCHED,
// nothing more.
export function Prizes() {
  const { leagueId = '' } = useParams()
  const { apiFetch } = useApi()
  const [data, setData] = useState<PrizesPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiFetch<PrizesPayload>(`/api/leagues/${leagueId}/prizes`)
      .then(setData)
      .catch((e: Error) => setError(e.message))
  }, [apiFetch, leagueId])

  if (error) return <EmptyState title="Something went wrong">{error}</EmptyState>
  if (!data) {
    return (
      <div className="mns-page py-6 flex flex-col gap-2">
        <Skeleton h="2.2rem" w="45%" />
        <Skeleton h="7rem" />
        <Skeleton h="5rem" />
      </div>
    )
  }

  return (
    <div className="mns-page py-2 pb-24">
      <PageHeader
        back={`/league/${leagueId}`}
        backLabel="League home"
        title="Prizes"
        status={
          data.final
            ? `Final — ${data.final.seasonYear} season, recorded ${new Date(data.final.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}. The commissioner pays out from this record.`
            : 'The commissioner holds and pays the pot — this page keeps track.'
        }
      />

      <div className="mb-4 rounded-lg border border-[var(--color-border)] bg-mns-card p-5 text-center">
        <p className="text-[0.72rem] font-bold tracking-[0.14em] uppercase text-[var(--color-accent)] mb-1">
          Prize pool{data.final ? ' · final' : ''}
        </p>
        <b className="block text-[2.6rem] leading-none tabular-nums">
          {data.configured ? usd(data.totalUsd) : '—'}
        </b>
        {data.configured && data.wallet?.usdValue != null ? (
          <p className="mt-2 text-sm text-[var(--color-muted-foreground)] tabular-nums">
            {usd(data.potUsd)} cash + {usd(data.wallet.usdValue)} on-chain
            {data.wallet.gainPct != null ? (
              <b
                className={
                  'ml-2 ' +
                  (data.wallet.gainPct >= 0
                    ? 'text-[var(--color-accent)]'
                    : 'text-[var(--color-pick-loss,#ff453a)]')
                }
              >
                {data.wallet.gainPct >= 0 ? '+' : ''}
                {data.wallet.gainPct}%
              </b>
            ) : null}
          </p>
        ) : !data.configured ? (
          <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
            The commissioner hasn&rsquo;t set the pot yet.
          </p>
        ) : null}
      </div>

      {data.wallet ? (
        <div className="mb-4 rounded-lg border border-[var(--color-border)] bg-mns-card p-4 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-bold">Pool wallet</span>
            <span className="text-[var(--color-muted-foreground)] tabular-nums">{shortAddr(data.wallet.address)}</span>
          </div>
          {data.wallet.usdValue != null ? (
            <p className="mt-1 tabular-nums">
              {data.wallet.ethBalance?.toFixed(4)} ETH × {usd(data.wallet.ethPrice ?? 0)} ={' '}
              <b>{usd(data.wallet.usdValue)}</b>
              {data.wallet.lastUpdated ? (
                <span className="text-[var(--color-muted-foreground)]">
                  {' '}· as of{' '}
                  {new Date(data.wallet.lastUpdated).toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
              ) : null}
            </p>
          ) : (
            <p className="mt-1 text-[var(--color-muted-foreground)]">
              {data.wallet.error ?? 'No valuation yet.'}
            </p>
          )}
          {data.wallet.baselineUsd != null ? (
            <p className="mt-1 text-sm tabular-nums">
              <span className="text-[var(--color-muted-foreground)]">
                Baseline {usd(data.wallet.baselineUsd)}
                {data.wallet.baselineAt
                  ? ` · locked ${new Date(data.wallet.baselineAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                  : ''}{' '}
                ·
              </span>{' '}
              <b
                className={
                  (data.wallet.gainPct ?? 0) >= 0
                    ? 'text-[var(--color-accent)]'
                    : 'text-[var(--color-pick-loss,#ff453a)]'
                }
              >
                {(data.wallet.gainPct ?? 0) >= 0 ? '+' : ''}
                {data.wallet.gainPct ?? 0}% since day one
              </b>
            </p>
          ) : null}
          <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
            A public address being watched, read-only — its balance and full history are visible
            to anyone on-chain.
          </p>
        </div>
      ) : null}

      {data.splits.length > 0 ? (
        <ul className="flex flex-col gap-2 mb-4">
          {data.splits.map((sp, i) => (
            <li
              key={i}
              className="rounded-lg border border-[var(--color-border)] bg-mns-card px-4 py-3"
            >
              <div className="flex items-baseline justify-between gap-3">
                <b className="flex items-center gap-1.5">
                  {i === 0 ? <Trophy aria-hidden className="w-4 h-4 text-[var(--color-key,#ffb000)]" /> : null}
                  {sp.label}
                </b>
                <b className="shrink-0 text-lg tabular-nums">
                  {data.configured ? usd(sp.amountUsd) : `${sp.share}%`}
                </b>
              </div>
              <p className="text-sm text-[var(--color-muted-foreground)]">
                {sp.share}% of the pot
                {sp.holder ? (data.final ? ` · ${sp.holder}` : ` · currently ${sp.holder}`) : ''}
              </p>
            </li>
          ))}
        </ul>
      ) : data.configured ? (
        <p className="mb-4 text-sm text-[var(--color-muted-foreground)]">
          No payout splits set yet.
        </p>
      ) : null}

      {data.isCommissioner ? (
        <Button to={`/league/${leagueId}/lm/league`} variant="quiet" full>
          Edit pot &amp; payouts
        </Button>
      ) : null}
    </div>
  )
}
