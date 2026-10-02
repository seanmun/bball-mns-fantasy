import type { SportAdapter } from './types'
import { wnba } from './wnba'
import type { Sport } from '../../types/leagueConfig'

// One codebase, deployed once per sport. VITE_SPORT on the Vercel
// project (and in .env.local) says which ball this deployment plays
// with; everything sport-specific hangs off the adapter it names.
//
// A missing or unknown value FAILS LOUDLY at boot — a blank page and a
// clear error — rather than quietly serving one sport's schema under
// the other sport's domain.

const ADAPTERS: Record<Sport, SportAdapter> = {
  wnba,
  // nba lands with its own file; until then the key is refused below.
  nba: undefined as unknown as SportAdapter,
}

export function sportFor(key: string | undefined): SportAdapter {
  const adapter = key ? ADAPTERS[key as Sport] : undefined
  if (!adapter) {
    throw new Error(
      `VITE_SPORT must name a sport this build knows (${Object.keys(ADAPTERS)
        .filter((k) => ADAPTERS[k as Sport])
        .join(', ')}) — got ${JSON.stringify(key)}. Set it on the Vercel project and in .env.local.`
    )
  }
  return adapter
}

function readKey(): string | undefined {
  // Node (API functions, drizzle-kit, vitest) reads the process env;
  // the browser bundle gets import.meta.env inlined by Vite.
  const fromProcess =
    typeof process !== 'undefined' && process.env ? process.env.VITE_SPORT : undefined
  if (fromProcess) return fromProcess
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> }
  return meta.env?.VITE_SPORT
}

export const sport: SportAdapter = sportFor(readKey())
export type { SportAdapter } from './types'
