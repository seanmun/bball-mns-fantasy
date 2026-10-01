import type { LeagueConfig } from '../types/leagueConfig'

export interface CurrentFees {
  firstApronFee: number
  secondApronPenalty: number
}

export interface ComputedApronFees {
  firstApronFee: number
  secondApronPenalty: number
  firstApronTriggered: boolean
  secondApronWatermarkRaised: boolean
}

// Compute apron fees with the two mns/ business rules baked in:
//
//   first apron  — STICKY. Once charged in a season, stays charged
//                  even if cap drops below the threshold later.
//   second apron — WATERMARK. Tracks the peak penalty during the
//                  season; never decreases even if cap drops.
//
// Caller passes the current persisted fee state; this returns the new
// state. Both flags say whether anything *changed* — useful for fee
// transaction logging.
export function computeApronFees(params: {
  capUsed: number
  config: LeagueConfig
  current: CurrentFees
}): ComputedApronFees {
  const { capUsed, config, current } = params

  let firstApronFee = current.firstApronFee
  let firstApronTriggered = false
  if (
    firstApronFee === 0 &&
    config.cap.firstApron > 0 &&
    capUsed > config.cap.firstApron
  ) {
    firstApronFee = config.fees.firstApronFee
    firstApronTriggered = true
  }

  let secondApronPenalty = current.secondApronPenalty
  let secondApronWatermarkRaised = false
  if (config.cap.secondApron > 0 && capUsed > config.cap.secondApron) {
    const overByM = Math.ceil(
      (capUsed - config.cap.secondApron) / 1_000_000
    )
    const newPenalty = overByM * penaltyRate(config)
    if (newPenalty > secondApronPenalty) {
      secondApronPenalty = newPenalty
      secondApronWatermarkRaised = true
    }
  }

  return {
    firstApronFee,
    secondApronPenalty,
    firstApronTriggered,
    secondApronWatermarkRaised,
  }
}

// The rate lives in two places in the config (cap and fees); the cap
// one wins when set, the fees one fills in.
export const penaltyRate = (config: LeagueConfig): number =>
  config.cap?.penaltyRatePerM || config.fees?.penaltyRatePerM || 0

export interface CapExposure {
  overFirst: boolean
  overSecondBy: number
  // What WILL book at the next first tip, net of the ledger.
  firstApronPending: number
  secondApronPending: number
  pendingTotal: number
}

// Where a roster stands against the aprons right now, net of what is
// already on the ledger — the forecast the cap card and the pre-tip
// email show. Same thresholds and rounding as computeApronFees, so
// the forecast and the booking never disagree.
export function capExposure(capUsed: number, config: LeagueConfig, booked: CurrentFees): CapExposure {
  const cap = config.cap
  const overFirst = (cap?.firstApron ?? 0) > 0 && capUsed > cap.firstApron
  const firstApronPending = overFirst && booked.firstApronFee === 0 ? config.fees?.firstApronFee ?? 0 : 0
  const overSecondBy = (cap?.secondApron ?? 0) > 0 ? Math.max(0, capUsed - cap.secondApron) : 0
  const livePenalty = Math.ceil(overSecondBy / 1_000_000) * penaltyRate(config)
  const secondApronPending = Math.max(0, livePenalty - booked.secondApronPenalty)
  return {
    overFirst,
    overSecondBy,
    firstApronPending,
    secondApronPending,
    pendingTotal: firstApronPending + secondApronPending,
  }
}

const fmtM = (n: number) => `$${(n / 1_000_000).toFixed(1)}M`

// One plain sentence for a toast or an email, or null when nothing
// is pending.
export function capNotice(x: CapExposure, booksAtClock: string | null): string | null {
  if (x.pendingTotal <= 0) return null
  const parts: string[] = []
  if (x.firstApronPending > 0) parts.push(`a $${x.firstApronPending} first-apron fee`)
  if (x.secondApronPending > 0) {
    parts.push(`$${x.secondApronPending} more second-apron penalty (${fmtM(x.overSecondBy)} over)`)
  }
  const when = booksAtClock ? `at tonight's first tip (${booksAtClock} ET)` : "at the next game day's first tip"
  return `You're over the ${x.overSecondBy > 0 ? 'second' : 'first'} apron — ${parts.join(' and ')} books ${when} unless you get under.`
}
