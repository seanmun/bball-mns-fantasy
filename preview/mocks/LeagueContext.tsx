/* eslint-disable react-refresh/only-export-components -- preview harness, never hot-reloaded */
import league from '../fixtures/league.json'
export function useLeague() {
  return { currentLeague: league as unknown as import('../../src/types/league').League, leagues: [league], loading: false, refreshLeagues: () => {}, setCurrentLeague: () => {} }
}
export function LeagueProvider({ children }: { children: React.ReactNode }) { return <>{children}</> }
