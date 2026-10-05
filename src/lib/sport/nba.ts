import type { SportAdapter } from './types'
import type { LeagueConfig } from '../../types/leagueConfig'

// NBA, 2026-27. Everything here is a starting point the commissioner
// edits in league settings; the numbers that come from the league
// itself are marked with their source and date.
//
// The cap ladder is Sean's own league from 2025-26 ($195M cap and
// first apron, $225M second apron, $255M hard cap) grown by the real
// 2026-27 cap rise, $154.647M → $164.961M = +6.67% (NBA via Hoops
// Rumors, June 2026). The real 2026-27 numbers, for reference: cap
// $164.961M, first apron $209.015M, second apron $221.686M.

// The lowest salary a player can carry: the 2026-27 minimum for zero
// years of service (Hoops Rumors, July 2026). ESPN lists about one
// roster player in five with no contract line — rookies on scale
// deals the feed has not filled in, and two-ways — and Sean's rule
// (Oct 1 2026) is that they carry this number, never zero.
export const NBA_LEAGUE_MINIMUM_2026_27 = 1_357_763

export const NBA_LEAGUE_PRESET: LeagueConfig = {
  sport: 'nba',
  season: {
    // ESPN counts 2026-27 as season 2027 (contracts[].year), and the
    // hub's slug convention is mns-nba-2027.
    year: 2027,
    startDate: '2026-10-20',
    weeks: 19,
  },
  roster: {
    activeSize: 13,
    starterSize: 10,
    // The lineup shape: the five positions, a guard and a forward
    // flex, three utility. Players float to any slot they qualify for.
    positionSlots: [
      { code: 'PG', count: 1 },
      { code: 'SG', count: 1 },
      { code: 'SF', count: 1 },
      { code: 'PF', count: 1 },
      { code: 'C', count: 1 },
      { code: 'G', count: 1 },
      { code: 'F', count: 1 },
      { code: 'UTIL', count: 3 },
    ],
    irSlots: 3,
    benchAllowed: true,
    maxKeepers: 6,
    redshirtsAllowed: true,
    intStashAllowed: true,
  },
  draft: {
    rounds: 13,
    type: 'snake',
    rookieRounds: 2,
    rookieYearsTracked: 3,
    rookieOrderMethod: 'manual',
    allowAdminOverride: true,
  },
  cap: {
    enabled: true,
    annualIncreasePct: 6.67,
    floor: 0,
    base: 208_000_000,
    firstApron: 208_000_000,
    secondApron: 240_000_000,
    hardCap: 272_000_000,
    tradeDelta: 0,
    // Fantasy dollars per $1M over the second apron, booked at first tip.
    penaltyRatePerM: 10,
  },
  fees: {
    buyIn: 50,
    firstApronFee: 25,
    franchiseTagFee: 15,
    redshirtFee: 10,
    activationFee: 25,
    penaltyRatePerM: 10,
  },
  scoring: {
    categories: ['FG%', 'FT%', '3PM', 'PTS', 'REB', 'AST', 'STL', 'BLK', 'A/TO'],
    mode: 'category_record',
  },
  keeper: {
    rookieRoundMap: {
      '1.1-1.3': 4,
      '1.4-1.6': 5,
      '1.7-1.9': 6,
      '1.10-1.12': 7,
      '2.x': 10,
      '3.x': 10,
    },
    advanceRule: 'minus_one',
    fallbackRound: null,
    franchiseTagAllowed: true,
    intStashAllowed: true,
  },
  schedule: {
    // The NBA trade deadline falls in early February.
    tradeDeadlineWeek: 16,
    tradeDeadlineDate: '',
    playoffTeams: 6,
    playoffWeeks: 3,
    playoffByeTeams: 2,
    consolationWeeks: 0,
    combineCup: false,
    combineAllStar: true,
    extendFirstWeek: false,
  },
  prizePool: {
    enabled: true,
    walletEnabled: false,
    zones: {
      boilerThreshold: 300,
      bernieThreshold: 10_000,
      gekkoSplit: [70, 20, 10],
      bernieSplit: [40, 15, 9, 4, 4, 4, 4, 4, 4, 4, 4, 4],
      boilerSmallSplit: [80, 20],
    },
  },
  notifications: {
    telegramEnabled: true,
    emailEnabled: true,
    drafts: true,
    trades: true,
    wagers: true,
  },
}

const appUrl = 'https://nba.mnsfantasy.com'

export const nba: SportAdapter = {
  key: 'nba',
  leagueLabel: 'NBA',
  schema: 'nba',
  espn: {
    league: 'basketball/nba',
    // The NBA pool is built from ESPN itself, so its codes are ours.
    codeAlias: {},
  },
  // Sean's rule (Oct 1 2026): anyone on an ESPN NBA roster is
  // rostered, two-ways included. A missing jersey number means nothing
  // here (Lakers listed 11 of 20 without one). The stash slot is for
  // draft-and-stash players on no ESPN roster at all, which the bios
  // pass reads as "absent" exactly as it does for the WNBA.
  presence: () => 'rostered',
  // ESPN publishes NBA contracts on the roster feed: contracts[] by
  // season year; the league minimum fills any gap.
  salary: { source: 'espn-contracts', minimum: NBA_LEAGUE_MINIMUM_2026_27 },
  positions: {
    feed: ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'],
    defaultShape: NBA_LEAGUE_PRESET.roster.positionSlots ?? [],
  },
  calendar: { seasonYear: 2027, seasonStart: '2026-10-20', preseasonStart: '2026-10-03' },
  preset: NBA_LEAGUE_PRESET,
  branding: {
    identity: {
      appName: 'MNS NBA',
      shortName: 'MNS NBA',
      longName: 'Money Never Sleeps NBA',
      tagline: 'Dynasty fantasy NBA — every dollar counts',
      sport: 'nba',
      seasonLabel: '2026-27 NBA',
    },
    assets: {
      logo: '/icons/mnsBall-icon.webp',
      favicon: '/icons/mnsBall-icon.webp',
      ogImage: '/icons/moneyneversleeps-icon.webp',
      appleTouchIcon: '/icons/mnsBall-icon.webp',
      heroVideoDesktop: '/video/left-ball.mp4',
      heroVideoMobile: '/video/center-ball.mp4',
      hinkieFolder: '/hinkie',
      prizePoolFolder: '/prizePool',
    },
    colors: {
      accent: '#22c55e',
      accentLight: '#4ade80',
      accentDark: '#16a34a',
      background: '#0a0a0a',
      card: '#121212',
      hover: '#1a1a1a',
      danger: '#ef4444',
      warning: '#f59e0b',
    },
    footer: {
      copyright: '© 2026 Money Never Sleeps',
      links: [
        { label: 'About', href: '/about' },
        { label: 'Roadmap', href: '/roadmap' },
        { label: 'Changelog', href: '/changelog' },
        { label: 'Media', href: '/media' },
        { label: 'Privacy', href: '/privacy' },
      ],
    },
    platform: {
      parentUrl: 'https://mnsfantasy.com',
      appUrl,
      supportEmail: 'noreply@e.moneyneversleeps.app',
    },
  },
  appName: 'MNS NBA',
  appUrl,
  appHost: 'nba.mnsfantasy.com',
  hub: {
    gameSlug: (year) => `mns-nba-${year}`,
    chatGame: 'nba',
  },
}
