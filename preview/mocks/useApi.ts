// The preview harness answers the API from fixtures. Writes succeed and change nothing.
import { useCallback } from 'react'
import keepers from '../fixtures/keepers.json'
import stats from '../fixtures/stats.json'
import cards from '../fixtures/cards.json'
export function useApi() {
  const apiFetch = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}'))
      if (body.action === 'scenario') return { savedScenarios: [{ scenarioId: 'p1', name: body.name, timestamp: Date.now(), entries: body.entries, summary: { keepersCount: 6, capUsed: 201_300_000, totalFees: 45 } }] } as T
      return { ok: true } as T
    }
    if (path.endsWith('/keepers')) return keepers as T
    if (path.endsWith('/stats')) return stats as T
    const card = path.match(/\/players\/([^/?]+)$/)
    if (card && (cards as Record<string, unknown>)[card[1]]) return (cards as Record<string, unknown>)[card[1]] as T
    throw new Error(`preview: no fixture for ${path}`)
  }, [])
  return { apiFetch }
}
