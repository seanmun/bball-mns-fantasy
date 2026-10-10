export type Sport = 'wnba' | 'nba'
export type EntryPhase = 'rookie_draft' | 'keeper_season' | 'draft' | 'regular_season'
export type RosterSource = 'fresh' | 'import'

// Where a league enters the season lifecycle. Chosen once by the
// commissioner on league home; steps before entryPhase are N/A.
export interface LeagueSetup {
  entryPhase: EntryPhase
  rosterSource: RosterSource
  // The commissioner has saved League settings at least once: the
  // Settings stage of the checklist is done.
  settingsSaved?: boolean
}
export type ScoringModeId = 'matchup_record' | 'category_record'
export type DraftType = 'snake' | 'auction'
export type RookieOrderMethod = 'lottery' | 'manual' | 'season_record'
export type KeeperAdvanceRule = 'minus_one' | 'flat' | 'custom'

export interface LeagueConfig {
  sport: Sport
  // Absent until the commissioner picks a starting scenario.
  setup?: LeagueSetup
  season: {
    year: number
    startDate: string
    weeks: number
    // Which feed writes stat lines: real box scores, or the seeded
    // simulator (test seasons, league gaps). Default 'espn'.
    statSource?: 'espn' | 'sim'
  }
  roster: {
    activeSize: number
    // The active lineup's shape, e.g. [{C:2},{F:4},{G:4}]. Empty or
    // absent means all-flex — any activeSize players, which is how
    // Beta Babes runs. FLEX/UTIL slots take anyone.
    positionSlots?: Array<{ code: string; count: number }>
    starterSize: number
    irSlots: number
    benchAllowed: boolean
    maxKeepers: number
    redshirtsAllowed: boolean
    intStashAllowed: boolean
  }
  draft: {
    rounds: number
    type: DraftType
    // Off = one regular draft a year; the rollover skips the
    // rookie_draft phase entirely.
    rookieDraftEnabled?: boolean
    rookieRounds: number
    rookieYearsTracked: number
    rookieOrderMethod: RookieOrderMethod
    allowAdminOverride: boolean
  }
  cap: {
    enabled: boolean
    // Applied to the whole ladder at season rollover (percent).
    annualIncreasePct?: number
    floor: number
    base: number
    firstApron: number
    secondApron: number
    hardCap: number
    tradeDelta: number
    penaltyRatePerM: number
  }
  fees: {
    buyIn: number
    firstApronFee: number
    franchiseTagFee: number
    redshirtFee: number
    activationFee: number
    penaltyRatePerM: number
  }
  // The pot, TRACKED never handled (platform law, set by NFL's Prizes
  // tab): cash the manager holds plus an optional public wallet whose
  // live value counts in. Splits are percents so they follow the pot.
  prizes?: {
    potUsd: number
    walletAddress: string | null
    splits: Array<{ label: string; share: number }>
  }
  scoring: {
    categories: string[]
    mode: ScoringModeId
  }
  keeper: {
    rookieRoundMap: Record<string, number>
    advanceRule: KeeperAdvanceRule
    fallbackRound: number | null
    franchiseTagAllowed: boolean
    intStashAllowed: boolean
  }
  schedule: {
    tradeDeadlineWeek: number
    tradeDeadlineDate: string
    playoffTeams: number
    playoffWeeks: number
    playoffByeTeams: number
    consolationWeeks: number
    // Calendar weeks folded into one matchup week — the Cup final week,
    // the All-Star break, a FIBA window. Suggested from the sport's
    // real schedule at setup; the commissioner decides.
    combinedWeeks: Array<{ calendarWeeks: number[]; label: string }>
    extendFirstWeek: boolean
  }
  prizePool: {
    enabled: boolean
    walletEnabled: boolean
    zones: {
      boilerThreshold: number
      bernieThreshold: number
      gekkoSplit: [number, number, number]
      bernieSplit: number[]
      boilerSmallSplit: [number, number]
    }
  }
  notifications: {
    telegramEnabled: boolean
    telegramChatId?: string
    emailEnabled: boolean
    drafts: boolean
    trades: boolean
    wagers: boolean
  }
}
