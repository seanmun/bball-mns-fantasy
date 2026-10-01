import type { VercelRequest, VercelResponse } from '@vercel/node'
import { eq } from 'drizzle-orm'
import { verifyAuth } from '../../_middleware.js'
import { db } from '../../_db.js'
import { mnsLeagues, mnsPortfolios, mnsTeams } from '../../../src/lib/db/schema.js'
import { computeStandings } from '../../../src/lib/season/score.js'
import { logger } from '../../_logger.js'
import { valueWallet } from '../../_wallet.js'
import { readFinalSnapshot } from '../../../src/lib/season/finals.js'
import type { LeagueConfig } from '../../../src/types/leagueConfig.js'

// The prize pool, TRACKED never handled: cash the manager holds plus
// the live value of an optional PUBLIC wallet (Alchemy balance ×
// CoinGecko price, the legacy mns recipe). Valuations cache in
// wnba.portfolios for ten minutes so browsing doesn't hammer the RPC.
//
// GET /api/leagues/:id/prizes
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = String(req.query.id ?? '')
  try {
    const [league] = await db.select().from(mnsLeagues).where(eq(mnsLeagues.id, leagueId)).limit(1)
    if (!league) return res.status(404).json({ error: 'League not found' })
    const config = league.config as LeagueConfig
    const prizes = config.prizes ?? { potUsd: 0, walletAddress: null, splits: [] }

    // Once the season is crowned the record is frozen: the pot as it
    // stood at the flip and who won each place. No live valuation, no
    // standings recompute — the number the commissioner pays out.
    const final = await readFinalSnapshot(db, leagueId, league.seasonYear)
    if (final) {
      return res.status(200).json({
        potUsd: final.pot.potUsd,
        wallet: final.pot.walletAddress
          ? {
              address: final.pot.walletAddress,
              ethBalance: null,
              ethPrice: null,
              usdValue: final.pot.walletUsd,
              lastUpdated: final.finalizedAt,
              error: null,
            }
          : null,
        totalUsd: final.pot.totalUsd,
        splits: final.splits.map((sp) => ({
          label: sp.label,
          share: sp.share,
          amountUsd: sp.amountUsd,
          holder: sp.name,
        })),
        configured: !!config.prizes,
        isCommissioner: league.commissionerId === userId,
        final: {
          at: final.finalizedAt,
          seasonYear: final.seasonYear,
          champion: final.champion,
          runnerUp: final.runnerUp,
          places: final.places,
        },
      })
    }

    // Wallet valuation, cache-first.
    let wallet: {
      address: string
      ethBalance: number | null
      ethPrice: number | null
      usdValue: number | null
      lastUpdated: string | null
      error: string | null
      baselineUsd?: number | null
      baselineAt?: string | null
      gainPct?: number | null
    } | null = null
    if (prizes.walletAddress && /^0x[a-fA-F0-9]{40}$/.test(prizes.walletAddress)) {
      const address = prizes.walletAddress
      const [cached] = await db
        .select()
        .from(mnsPortfolios)
        .where(eq(mnsPortfolios.id, leagueId))
        .limit(1)
      const fresh =
        cached &&
        cached.walletAddress === address &&
        Date.now() - new Date(cached.lastUpdated).getTime() < 10 * 60 * 1000
      if (fresh) {
        wallet = {
          address,
          ethBalance: cached.cachedEthBalance != null ? Number(cached.cachedEthBalance) : null,
          ethPrice: cached.cachedEthPrice != null ? Number(cached.cachedEthPrice) : null,
          usdValue: cached.cachedUsdValue != null ? Number(cached.cachedUsdValue) : null,
          lastUpdated: cached.lastUpdated.toISOString(),
          error: null,
        }
      } else {
        wallet = await valueWallet(address)
        if (wallet.usdValue != null) {
          // The BASELINE (usdInvested) locks at the first successful
          // valuation — day 1 of tracking — and is never overwritten;
          // gain/loss reads against it from then on. A new address
          // starts a new baseline.
          await db
            .insert(mnsPortfolios)
            .values({
              id: leagueId,
              leagueId,
              walletAddress: address,
              usdInvested: String(wallet.usdValue),
              cachedEthBalance: String(wallet.ethBalance),
              cachedEthPrice: String(wallet.ethPrice),
              cachedUsdValue: String(wallet.usdValue),
              lastUpdated: new Date(),
            })
            .onConflictDoUpdate({
              target: mnsPortfolios.id,
              set: {
                walletAddress: address,
                ...(cached && cached.walletAddress !== address
                  ? { usdInvested: String(wallet.usdValue), createdAt: new Date() }
                  : {}),
                cachedEthBalance: String(wallet.ethBalance),
                cachedEthPrice: String(wallet.ethPrice),
                cachedUsdValue: String(wallet.usdValue),
                lastUpdated: new Date(),
                updatedAt: new Date(),
              },
            })
        } else if (cached && cached.walletAddress === address) {
          // Live lookup failed — serve the stale cache honestly.
          wallet = {
            address,
            ethBalance: cached.cachedEthBalance != null ? Number(cached.cachedEthBalance) : null,
            ethPrice: cached.cachedEthPrice != null ? Number(cached.cachedEthPrice) : null,
            usdValue: cached.cachedUsdValue != null ? Number(cached.cachedUsdValue) : null,
            lastUpdated: cached.lastUpdated.toISOString(),
            error: wallet.error,
          }
        }
      }
    }

    // Attach the locked baseline and the move since.
    if (wallet) {
      const [row] = await db
        .select()
        .from(mnsPortfolios)
        .where(eq(mnsPortfolios.id, leagueId))
        .limit(1)
      const baseline = row ? Number(row.usdInvested) : 0
      if (row && baseline > 0) {
        wallet.baselineUsd = baseline
        wallet.baselineAt = row.createdAt.toISOString()
        wallet.gainPct =
          wallet.usdValue != null
            ? Math.round(((wallet.usdValue - baseline) / baseline) * 1000) / 10
            : null
      }
    }

    const totalUsd = (prizes.potUsd || 0) + (wallet?.usdValue ?? 0)

    // Who currently holds each paid place, straight from standings.
    const teams = await db.select().from(mnsTeams).where(eq(mnsTeams.leagueId, leagueId))
    const rec = await computeStandings(db, leagueId, league.seasonYear)
    const ranked = teams
      .map((t) => ({ name: t.name, ...(rec.get(t.id) ?? { wins: 0, losses: 0, ties: 0, pointsFor: 0 }) }))
      .sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor)

    return res.status(200).json({
      potUsd: prizes.potUsd || 0,
      wallet,
      totalUsd,
      splits: prizes.splits.map((sp, i) => ({
        ...sp,
        amountUsd: Math.round(totalUsd * sp.share) / 100,
        holder: ranked[i]?.name ?? null,
      })),
      configured: !!config.prizes,
      isCommissioner: league.commissionerId === userId,
    })
  } catch (err) {
    logger.error('GET /api/leagues/[id]/prizes failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Failed to load the prize pool' })
  }
}
