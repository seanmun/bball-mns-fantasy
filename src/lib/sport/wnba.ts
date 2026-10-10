import type { SportAdapter } from './types'
import type { LeagueConfig } from '../../types/leagueConfig'

// Default LeagueConfig for new WNBA leagues. Commissioners override any
// field via league settings. Numbers below are starting points, not
// law — adjust freely. Aprons are OFF (zero): the app never looks for
// them until a commissioner switches them on.
export const WNBA_LEAGUE_PRESET: LeagueConfig = {
  sport: 'wnba',
  season: {
    year: 2026,
    startDate: '2026-05-11',
    weeks: 13,
  },
  roster: {
    activeSize: 10,
    starterSize: 10,
    irSlots: 3,
    benchAllowed: false,
    maxKeepers: 5,
    redshirtsAllowed: true,
    intStashAllowed: true,
  },
  draft: {
    rounds: 10,
    type: 'snake',
    rookieRounds: 2,
    rookieYearsTracked: 3,
    rookieOrderMethod: 'manual',
    allowAdminOverride: true,
  },
  cap: {
    enabled: true,
    floor: 0,
    base: 1_500_000,
    firstApron: 0,
    secondApron: 0,
    hardCap: 1_500_000,
    tradeDelta: 0,
    penaltyRatePerM: 0,
  },
  fees: {
    buyIn: 50,
    firstApronFee: 0,
    franchiseTagFee: 15,
    redshirtFee: 10,
    activationFee: 25,
    penaltyRatePerM: 0,
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
    tradeDeadlineWeek: 9,
    tradeDeadlineDate: '',
    playoffTeams: 6,
    playoffWeeks: 3,
    playoffByeTeams: 2,
    consolationWeeks: 0,
    combinedWeeks: [],
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

const appUrl = 'https://wnba.mnsfantasy.com'

export const wnba: SportAdapter = {
  key: 'wnba',
  leagueLabel: 'WNBA',
  schema: 'wnba',
  espn: {
    league: 'basketball/wnba',
    // The pool's team codes came from the legacy mns port; ESPN spells
    // a few differently. ESPN's spelling -> ours.
    codeAlias: { WSH: 'WAS', LA: 'LAS', PHX: 'PHO', LV: 'LVA', NY: 'NYL', GS: 'GSV' },
  },
  // A WNBA player listed with no number is not physically with the
  // team: drafted, never reported — the international stash case.
  presence: (a) => (a.jersey ? 'rostered' : 'rights_only'),
  // ESPN publishes no WNBA contracts; Her Hoop Stats does.
  salary: { source: 'herhoopstats' },
  positions: { feed: ['G', 'F', 'C'], defaultShape: [] },
  rookieClassYear: (seasonYear) => seasonYear,
  espnSeasonLabel: (seasonYear) => String(seasonYear),
  calendar: { seasonYear: 2026, seasonStart: '2026-05-11', seasonEnd: '2026-10-18' },
  preset: WNBA_LEAGUE_PRESET,
  branding: {
    identity: {
      appName: 'MNS WNBA',
      shortName: 'MNS WNBA',
      longName: 'Money Never Sleeps WNBA',
      tagline: 'Dynasty fantasy WNBA — every dollar counts',
      sport: 'wnba',
      seasonLabel: '2026 WNBA',
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
  appName: 'MNS WNBA',
  appUrl,
  appHost: 'wnba.mnsfantasy.com',
  hub: {
    gameSlug: (year) => `mns-wnba-${year}`,
    chatGame: 'wnba',
  },
}
