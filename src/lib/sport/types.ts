import type { LeagueConfig, Sport } from '../../types/leagueConfig'
import type { Branding } from '../branding'

// Everything about this deployment that would change if the ball
// were a different ball. One object, chosen once by VITE_SPORT, read
// everywhere a sport-specific fact used to be a string literal. The
// engine — drafts, waivers, trades, scoring, the cap — never reads
// anything else about the sport.
export interface SportAdapter {
  key: Sport
  // "WNBA" / "NBA" — the league's own name, for copy.
  leagueLabel: string
  // Postgres schema holding every one of this sport's tables.
  schema: string
  // ESPN's public site API path segment, and their team-code spellings
  // mapped onto ours.
  espn: {
    league: string
    codeAlias: Record<string, string>
  }
  // Where a player on an ESPN roster actually is. The WNBA's "no
  // jersey number" rule does NOT hold in the NBA, so each sport judges.
  presence(athlete: { jersey?: string | null }): 'rostered' | 'rights_only'
  // Where salaries come from. The server picks the implementation.
  salary: {
    source: 'herhoopstats' | 'espn-contracts'
    // What a player carries when the source has no number for them.
    minimum?: number
  }
  positions: {
    // What the feed labels players with.
    feed: string[]
    // The lineup shape a new league starts with; empty = all-flex.
    defaultShape: Array<{ code: string; count: number }>
  }
  // The draft class a league season's rookies come from, for copy: the
  // NBA's 2026-27 season (seasonYear 2027) drafts the class of 2026; the
  // WNBA drafts in April of the season itself.
  rookieClassYear(seasonYear: number): number
  // ESPN's name for a season, by the league's season year (its END
  // year): NBA 2026 → "2025-26", WNBA 2025 → "2025".
  espnSeasonLabel(seasonYear: number): string
  calendar: {
    seasonYear: number
    seasonStart: string // YYYY-MM-DD, first regular-season day
    // Last date the sport pass pulls game counts for — past the regular
    // season so playoff weeks show up too.
    seasonEnd: string
    preseasonStart?: string
  }
  // The config a new league starts from. Commissioners override any
  // field in league settings.
  preset: LeagueConfig
  branding: Branding
  appName: string // "MNS WNBA"
  appUrl: string // https://wnba.mnsfantasy.com
  appHost: string // wnba.mnsfantasy.com
  hub: {
    // The hub's games-config slug for a season.
    gameSlug: (year: number) => string
    // What the hub's assistant is told the member is looking at.
    chatGame: Sport
  }
}
