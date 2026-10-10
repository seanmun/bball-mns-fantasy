import type { Sport } from './leagueConfig'

export type PlayerSlot = 'active' | 'bench' | 'ir' | 'redshirt' | 'international'
export type MigrationSource = 'espn' | 'yahoo' | 'sleeper' | 'fantrax' | 'manual'

// Platform-specific player identifiers. Each platform writes its own
// key when syncing. WNBA players won't have `fantrax` (Fantrax doesn't
// cover WNBA); NBA players from Fantrax will. Add new keys as new
// sources land.
export interface ExternalIds {
  fantrax?: string
  hhs?: string // Her Hoop Stats slug
  wnba?: string // wnba.com / stats.wnba.com player ID
  yahoo?: string
  espn?: string
  sleeper?: string
}

export interface RookieDraftInfo {
  round: number
  pick: number
  redshirtEligible: boolean
  redshirtedLastYear?: boolean
  // The league season this slot was drafted for (the rookie board's
  // seasonYear). Absent on a slot typed by hand for last year's redshirt.
  seasonYear?: number
}

export interface Player {
  id: string
  externalIds: ExternalIds
  name: string
  position: string
  salary: number
  teamCode: string
  leagueId: string
  teamId: string | null
  sport: Sport
  slot: PlayerSlot
  onIR: boolean
  age?: number | null
  redshirtUsed?: boolean
  yearsPro?: number | null
  leaguePresence?: string | null
  presenceOverride?: string | null
  injuryStatus?: string | null
  injuryNote?: string | null
  injuryUpdatedAt?: string | null
  isRookie: boolean
  isInternationalStash: boolean
  intEligible: boolean
  rookieDraftInfo: RookieDraftInfo | null
  keeperPriorYearRound: number | null
  // The round this player occupied in THIS season's draft — kept there
  // or picked there. Becomes keeperPriorYearRound at the turn of the year.
  draftRound?: number | null
  keeperDerivedBaseRound: number | null
  migratedKeeperRound: number | null
  migrationSource: MigrationSource | null
  createdAt: string
  updatedAt: string
}
