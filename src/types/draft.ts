export type DraftStatus = 'setup' | 'in_progress' | 'paused' | 'completed'

export interface DraftPick {
  round: number
  pickInRound: number
  overallPick: number
  teamId: string
  teamName: string
  teamAbbrev: string
  playerId?: string
  playerName?: string
  isKeeperSlot: boolean
  pickedAt?: number
  pickedBy?: string
}

export interface DraftCurrentPick {
  round: number
  pickInRound: number
  overallPick: number
  teamId: string
  startedAt: number
}

export interface DraftSettings {
  allowAdminOverride?: boolean
  isTestDraft?: boolean
  // 'live' = 2-minute clock; 'slow' = 12h a pick, hub emails whoever
  // is up. Chosen at create, honoured at start.
  pace?: 'live' | 'slow'
}

export interface Draft {
  id: string
  leagueId: string
  seasonYear: number
  status: DraftStatus
  draftOrder: string[]
  currentPick: DraftCurrentPick | null
  picks: DraftPick[]
  settings: DraftSettings
  createdAt: string
  createdBy: string
  startedAt: string | null
  completedAt: string | null
  updatedAt: string
}

export interface PickTradeHistoryEntry {
  from: string
  to: string
  tradedAt: number | null
}

export interface PickAssignment {
  id: string
  leagueId: string
  seasonYear: number
  round: number
  pickInRound: number
  overallPick: number
  currentTeamId: string
  originalTeamId: string
  originalTeamName: string
  originalTeamAbbrev: string
  playerId: string | null
  playerName: string | null
  isKeeperSlot: boolean
  pickedAt: string | null
  pickedBy: string | null
  wasTraded: boolean
  tradeHistory: PickTradeHistoryEntry[]
  createdAt: string
  updatedAt: string
}

export interface RookieDraftPickRow {
  id: string
  leagueId: string
  seasonYear: number
  round: number
  pickInRound: number
  overallPick: number
  teamId: string
  originalTeamId: string | null
  playerId: string | null
  playerName: string | null
  createdAt: string
  updatedAt: string
}

export interface DraftHistory {
  id: string
  leagueId: string
  seasonYear: number
  picks: DraftPick[]
  keepers: DraftPick[]
  redshirtPlayers: string[]
  internationalPlayers: string[]
  completedAt: string
  completedBy: string
  createdAt: string
}
