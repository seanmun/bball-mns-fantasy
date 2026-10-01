import { and, eq, sql } from 'drizzle-orm'
import { mnsTeamFees } from '../db/schema.js'

// League dues the app TRACKS and never handles — same law as the prize
// pot. Redshirting costs a fee; activating one mid-season costs
// another. Each charge appends to the team's ledger so the
// commissioner can settle up from a list, not a memory.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export type FeeKind = 'redshirt' | 'unredshirt' | 'franchise_tag' | 'first_apron' | 'second_apron'

export interface FeeEntry {
  kind: FeeKind
  amount: number
  detail: string
  at: string
}

export async function chargeFee(
  db: Db,
  leagueId: string,
  teamId: string,
  seasonYear: number,
  kind: 'redshirt' | 'unredshirt' | 'franchise_tag',
  amount: number,
  detail: string,
  now = new Date()
): Promise<void> {
  if (!amount) return
  const entry: FeeEntry = { kind, amount, detail, at: now.toISOString() }
  const column =
    kind === 'redshirt'
      ? mnsTeamFees.redshirtFees
      : kind === 'unredshirt'
        ? mnsTeamFees.unredshirtFees
        : mnsTeamFees.franchiseTagFees
  await db
    .insert(mnsTeamFees)
    .values({
      id: `${leagueId}_${teamId}_${seasonYear}`,
      leagueId,
      teamId,
      seasonYear,
      ...(kind === 'redshirt' ? { redshirtFees: String(amount) } : {}),
      ...(kind === 'unredshirt' ? { unredshirtFees: String(amount) } : {}),
      ...(kind === 'franchise_tag' ? { franchiseTagFees: String(amount) } : {}),
      totalFees: String(amount),
      feeTransactions: [entry],
    })
    .onConflictDoUpdate({
      target: [mnsTeamFees.leagueId, mnsTeamFees.teamId, mnsTeamFees.seasonYear],
      set: {
        [kind === 'redshirt' ? 'redshirtFees' : kind === 'unredshirt' ? 'unredshirtFees' : 'franchiseTagFees']:
          sql`${column} + ${amount}`,
        totalFees: sql`${mnsTeamFees.totalFees} + ${amount}`,
        feeTransactions: sql`${mnsTeamFees.feeTransactions} || ${JSON.stringify([entry])}::jsonb`,
        updatedAt: now,
      },
    })
}

export async function teamFees(db: Db, leagueId: string, teamId: string, seasonYear: number) {
  const [row] = await db
    .select()
    .from(mnsTeamFees)
    .where(
      and(
        eq(mnsTeamFees.leagueId, leagueId),
        eq(mnsTeamFees.teamId, teamId),
        eq(mnsTeamFees.seasonYear, seasonYear)
      )
    )
    .limit(1)
  return row ?? null
}

const fmtM = (n: number) => `$${(n / 1_000_000).toFixed(1)}M`

// Cap dues, booked at first tip. The ledger holds the season's state
// (first apron fee: 0 or charged; second apron: the watermark), and
// each change appends a dated line for exactly the amount that moved.
export async function bookApronDues(
  db: Db,
  leagueId: string,
  teamId: string,
  seasonYear: number,
  next: { firstApronFee: number; secondApronPenalty: number },
  current: { firstApronFee: number; secondApronPenalty: number },
  capUsedNow: number,
  now = new Date()
): Promise<FeeEntry[]> {
  const at = now.toISOString()
  const entries: FeeEntry[] = []
  const firstDelta = next.firstApronFee - current.firstApronFee
  if (firstDelta > 0) {
    entries.push({
      kind: 'first_apron',
      amount: firstDelta,
      detail: `Over the first apron at first tip — ${fmtM(capUsedNow)} on the books`,
      at,
    })
  }
  const secondDelta = next.secondApronPenalty - current.secondApronPenalty
  if (secondDelta > 0) {
    entries.push({
      kind: 'second_apron',
      amount: secondDelta,
      detail: `Second-apron penalty raised to $${next.secondApronPenalty} — ${fmtM(capUsedNow)} on the books`,
      at,
    })
  }
  if (entries.length === 0) return []
  const total = entries.reduce((n, e) => n + e.amount, 0)
  await db
    .insert(mnsTeamFees)
    .values({
      id: `${leagueId}_${teamId}_${seasonYear}`,
      leagueId,
      teamId,
      seasonYear,
      firstApronFee: String(next.firstApronFee),
      secondApronPenalty: String(next.secondApronPenalty),
      totalFees: String(total),
      feeTransactions: entries,
    })
    .onConflictDoUpdate({
      target: [mnsTeamFees.leagueId, mnsTeamFees.teamId, mnsTeamFees.seasonYear],
      set: {
        firstApronFee: String(next.firstApronFee),
        secondApronPenalty: String(next.secondApronPenalty),
        totalFees: sql`${mnsTeamFees.totalFees} + ${total}`,
        feeTransactions: sql`${mnsTeamFees.feeTransactions} || ${JSON.stringify(entries)}::jsonb`,
        updatedAt: now,
      },
    })
  return entries
}
