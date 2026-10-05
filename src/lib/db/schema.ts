import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sport } from '../sport/index.js'
import { eq, isNotNull, sql } from 'drizzle-orm'

import type { LeagueConfig } from '../../types/leagueConfig'
import type { LeaguePhase, ScoringMode } from '../../types/league'
import type { TeamCapAdjustments } from '../../types/team'
import type {
  RosterEntry,
  RosterSummary,
  SavedScenario,
} from '../../types/roster'
import type {
  DraftPick,
  DraftSettings,
  DraftCurrentPick,
  PickTradeHistoryEntry,
} from '../../types/draft'
import type { TradeAsset } from '../../types/trade'
import type {
  ExternalIds,
  RookieDraftInfo,
  MigrationSource,
} from '../../types/player'

// ============================================================================
// SHARED TABLES (cross-game on the same Neon DB)
// ============================================================================

// All WNBA game tables live in the `wnba` Postgres schema. Shared
// cross-game tables (users, marketing_*) stay in `public`.
// Every table of this deployment's sport lives in the sport's own
// Postgres schema — wnba.*, nba.* — named by the adapter, never shared.
export const gameSchema = pgSchema(sport.schema)

// Matches the live shared `users` table created by ncaa-mns-fantasy.
// NOT-marking email .unique() here because the live table doesn't have
// that constraint (NCAA's TS schema declares it but never migrated).
// Pushing .unique() would prompt to truncate the table.
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  role: text('role').notNull().default('owner'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// ============================================================================
// LEAGUES + TEAMS
// ============================================================================

// `sport` and `gameSlug` are the cross-platform discriminators. Together
// they're enough to identify a league across the multi-tenant Neon DB.
// `gameSlug` matches the NCAA convention ('mns-wnba-2026', 'mns-nba-2027')
// for filtering in shared tables like marketing_game_prefs / email_log.
export const mnsLeagues = gameSchema.table(
  'leagues',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    seasonYear: integer('season_year').notNull(),
    sport: text('sport').notNull(),
    gameSlug: text('game_slug').notNull(),
    config: jsonb('config').$type<LeagueConfig>().notNull(),
    leaguePhase: text('league_phase')
      .$type<LeaguePhase>()
      .notNull()
      .default('keeper_season'),
    keepersLocked: boolean('keepers_locked').notNull().default(false),
    commissionerId: text('commissioner_id').references(() => users.id),
    scoringMode: text('scoring_mode')
      .$type<ScoringMode>()
      .notNull()
      .default('category_record'),
    seasonStartedAt: timestamp('season_started_at'),
    seasonStartedBy: text('season_started_by'),
    telegramChatId: text('telegram_chat_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_mns_leagues_commissioner').on(t.commissionerId),
    index('idx_mns_leagues_game_slug').on(t.gameSlug),
    index('idx_mns_leagues_sport_season').on(t.sport, t.seasonYear),
  ]
)

export const mnsTeams = gameSchema.table(
  'teams',
  {
    id: text('id').primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    abbrev: text('abbrev').notNull(),
    // Small data-URL image (client resizes to ~256px before upload) —
    // no blob store in the stack, and a 4..12-team league's logos fit
    // in the row just fine.
    logo: text('logo'),
    // The team's strategy dials for the assistant: sliders 0-100 plus
    // a free-text philosophy. PRIVATE to the team's owners — never in
    // public team payloads.
    aiPrefs: jsonb('ai_prefs').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    telegramUsername: text('telegram_username'),
    capAdjustments: jsonb('cap_adjustments')
      .$type<TeamCapAdjustments>()
      .notNull()
      .default(sql`'{"tradeDelta":0}'::jsonb`),
    banners: integer('banners').array().notNull().default(sql`'{}'::integer[]`),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [index('idx_mns_teams_league').on(t.leagueId)]
)

export const mnsTeamOwners = gameSchema.table(
  'team_owners',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    email: text('email').notNull(),
    displayName: text('display_name'),
    isPrimary: boolean('is_primary').notNull().default(false),
    // Per-owner email opt-outs: { waivers?, trades?, lineup? } — a
    // missing key means ON. Local by design (the NFL rule): these are
    // transactional, not hub marketing preferences.
    emailPrefs: jsonb('email_prefs').$type<Record<string, boolean>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.email] }),
    index('idx_mns_team_owners_email').on(t.email),
    index('idx_mns_team_owners_user').on(t.userId),
  ]
)

// ============================================================================
// PLAYERS
// ============================================================================

// WHO A PLAYER IS, independent of any league or any data source. League
// rows (players, below) hold what is league-specific — team, salary,
// slot, keeper round — and point here for identity.
//
// The crosswalk is the point: external_ids maps every source's key for
// this person ({ espn: '869', hhs: 'naz-hillmon', bbref: ... }), so a
// source swap is a new key, not a re-match. Names are resolved ONCE and
// written down; birth_date is the disambiguator that makes a name
// collision decidable instead of a guess.

// ============================================================================
// SPORT-LEVEL DATA — pulled from ESPN once per sport, served to every league
// ============================================================================
//
// The law: ESPN is read ONCE per sport per tick, never per league. These
// tables are the sport's truth; league rows point at them. Keys are
// ESPN's athlete ids, so box scores match exactly, never by name.

export const mnsSportPlayers = gameSchema.table(
  'sport_players',
  {
    // Ours. ESPN's athlete id when ESPN is the first source to list
    // her; `hhs:<slug>` for a WNBA player known only to Her Hoop Stats
    // (abroad, unsigned) until an ESPN roster names her.
    id: text('id').primaryKey(),
    // ESPN's athlete id once known — every box score keys on it.
    espnId: text('espn_id'),
    name: text('name').notNull(),
    // OUR team code (ESPN's spelling mapped through the adapter).
    teamCode: text('team_code').notNull().default(''),
    position: text('position').notNull().default(''),
    jersey: text('jersey'),
    age: integer('age'),
    dateOfBirth: text('date_of_birth'),
    yearsPro: integer('years_pro'),
    // rostered | rights_only | absent — judged by the sport adapter.
    presence: text('presence').notNull().default('absent'),
    // Real money, sport-level: the contract for this season, the
    // scraped figure, or the league minimum when the source has none.
    salary: bigint('salary', { mode: 'number' }).notNull().default(0),
    salarySource: text('salary_source').notNull().default('unknown'),
    salarySeasonYear: integer('salary_season_year'),
    externalIds: jsonb('external_ids').$type<ExternalIds>().notNull().default(sql`'{}'::jsonb`),
    injuryStatus: text('injury_status'),
    injuryNote: text('injury_note'),
    injuryUpdatedAt: timestamp('injury_updated_at'),
    // Last roster pull that listed her on a club.
    rosterSeenAt: timestamp('roster_seen_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('uq_sport_players_espn').on(t.espnId),
    index('idx_sport_players_team').on(t.teamCode),
    index('idx_sport_players_name').on(t.name),
  ]
)

export const mnsSportStatLines = gameSchema.table(
  'sport_stat_lines',
  {
    playerId: text('player_id')
      .notNull()
      .references(() => mnsSportPlayers.id, { onDelete: 'cascade' }),
    // Eastern-calendar date of the game, YYYY-MM-DD.
    date: text('date').notNull(),
    eventId: text('event_id'),
    min: integer('min').notNull().default(0),
    pts: integer('pts').notNull().default(0),
    fgm: integer('fgm').notNull().default(0),
    fga: integer('fga').notNull().default(0),
    ftm: integer('ftm').notNull().default(0),
    fta: integer('fta').notNull().default(0),
    tpm: integer('tpm').notNull().default(0),
    reb: integer('reb').notNull().default(0),
    ast: integer('ast').notNull().default(0),
    stl: integer('stl').notNull().default(0),
    blk: integer('blk').notNull().default(0),
    tov: integer('tov').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.playerId, t.date] }), index('idx_sport_stat_lines_date').on(t.date)]
)

// When each sport pass last ran — rosters and salaries once a day,
// box scores and injuries every tick — one row per kind per day.
export const mnsSportSync = gameSchema.table(
  'sport_sync',
  {
    kind: text('kind').notNull(),
    dateKey: text('date_key').notNull(),
    ranAt: timestamp('ran_at').defaultNow().notNull(),
    detail: jsonb('detail'),
  },
  (t) => [primaryKey({ columns: [t.kind, t.dateKey] })]
)

export const mnsPlayers = gameSchema.table(
  'players',
  {
    id: text('id').primaryKey(),
    leagueId: text('league_id').references(() => mnsLeagues.id, {
      onDelete: 'cascade',
    }),
    // The sport-level player this league row stands for. Identity,
    // salary, team, injury all live on sport_players; this row is the
    // LEAGUE's state for her (team, slot, keeper, redshirt).
    sportPlayerId: text('sport_player_id')
      .notNull()
      .references(() => mnsSportPlayers.id),
    teamId: text('team_id').references(() => mnsTeams.id, {
      onDelete: 'set null',
    }),
    sport: text('sport').notNull().default(sport.key),
    slot: text('slot').notNull().default('active'),
    onIR: boolean('on_ir').notNull().default(false),
    // Declared for next season during keeper_season; consumed when the
    // commissioner locks keepers and releases everyone else.
    isKeeper: boolean('is_keeper').notNull().default(false),
    // Redshirt: a rookie who has never played, parked for the season —
    // no roster spot, no cap hit, a fee each way. Once activated the
    // eligibility is SPENT, which is what redshirt_used remembers.
    redshirtedAt: timestamp('redshirted_at'),
    redshirtUsed: boolean('redshirt_used').notNull().default(false),
    // The commissioner's correction to the feed's presence read —
    // rostered, rights_only or absent — and it always wins.
    presenceOverride: text('presence_override'),
    isRookie: boolean('is_rookie').notNull().default(false),
    isInternationalStash: boolean('is_international_stash')
      .notNull()
      .default(false),
    intEligible: boolean('int_eligible').notNull().default(false),
    rookieDraftInfo: jsonb('rookie_draft_info').$type<RookieDraftInfo>(),
    keeperPriorYearRound: integer('keeper_prior_year_round'),
    keeperDerivedBaseRound: integer('keeper_derived_base_round'),
    migratedKeeperRound: integer('migrated_keeper_round'),
    migrationSource: text('migration_source').$type<MigrationSource>(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_mns_players_league').on(t.leagueId),
    index('idx_mns_players_team').on(t.teamId),
    index('idx_mns_players_league_team').on(t.leagueId, t.teamId),
    // One league row per sport player — the pool copy is idempotent.
    uniqueIndex('uq_mns_players_league_sport').on(t.leagueId, t.sportPlayerId),
  ]
)

// ============================================================================
// ROSTERS — keeper decisions
// ============================================================================

export const mnsRosters = gameSchema.table(
  'rosters',
  {
    id: text('id').primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    seasonYear: integer('season_year').notNull(),
    entries: jsonb('entries')
      .$type<RosterEntry[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    summary: jsonb('summary')
      .$type<RosterSummary | Record<string, never>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('draft'),
    savedScenarios: jsonb('saved_scenarios')
      .$type<SavedScenario[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_mns_rosters_league_season').on(t.leagueId, t.seasonYear),
    index('idx_mns_rosters_team').on(t.teamId),
  ]
)

// ============================================================================
// REGULAR-SEASON ROSTERS — active/IR/redshirt slot management
// ============================================================================

export const mnsRegularSeasonRosters = gameSchema.table(
  'regular_season_rosters',
  {
    id: text('id').primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    seasonYear: integer('season_year').notNull(),
    activeRoster: text('active_roster').array().notNull().default(sql`'{}'::text[]`),
    irSlots: text('ir_slots').array().notNull().default(sql`'{}'::text[]`),
    redshirtPlayers: text('redshirt_players').array().notNull().default(sql`'{}'::text[]`),
    internationalPlayers: text('international_players').array().notNull().default(sql`'{}'::text[]`),
    benchedPlayers: text('benched_players').array().notNull().default(sql`'{}'::text[]`),
    isLegalRoster: boolean('is_legal_roster').notNull().default(true),
    lastUpdated: timestamp('last_updated').defaultNow().notNull(),
    updatedBy: text('updated_by'),
  },
  (t) => [
    index('idx_mns_reg_season_rosters_league').on(t.leagueId),
    index('idx_mns_reg_season_rosters_team').on(t.teamId),
  ]
)

// ============================================================================
// DAILY LINEUPS
// ============================================================================

// One team's lineup for one Eastern date. `slots` is a FULL snapshot
// ({ playerId: 'active'|'bench'|'ir' }) written whenever an owner sets
// a slot for that day — today or ahead. The effective lineup for any
// date is the latest row at/before it (set it once, it carries
// forward); no row anywhere means the player's base slot. Past dates
// never get new rows: that is the lock.
export const mnsDailyLineups = gameSchema.table(
  'daily_lineups',
  {
    id: text('id').primaryKey().default(sql`(gen_random_uuid())::text`),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    gameDate: text('game_date').notNull(), // YYYY-MM-DD Eastern
    slots: jsonb('slots').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    // Legacy mirror of slots (the mns port's shape) — kept in sync on
    // write, never read.
    activePlayerIds: text('active_player_ids').array().notNull().default(sql`'{}'::text[]`),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    updatedBy: text('updated_by'),
  },
  (t) => [
    unique('mns_daily_lineups_team_date_key').on(t.teamId, t.gameDate),
    index('idx_mns_daily_lineups_team_date').on(t.teamId, t.gameDate),
  ]
)

// ============================================================================
// DRAFT
// ============================================================================

export const mnsDrafts = gameSchema.table(
  'drafts',
  {
    id: text('id').primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    seasonYear: integer('season_year').notNull(),
    status: text('status').notNull().default('setup'),
    draftOrder: text('draft_order').array().notNull().default(sql`'{}'::text[]`),
    currentPick: jsonb('current_pick').$type<DraftCurrentPick | null>(),
    picks: jsonb('picks').$type<DraftPick[]>().notNull().default(sql`'[]'::jsonb`),
    settings: jsonb('settings')
      .$type<DraftSettings>()
      .notNull()
      .default(sql`'{"allowAdminOverride":true,"isTestDraft":false}'::jsonb`),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    createdBy: text('created_by').notNull(),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [index('idx_mns_drafts_league_season').on(t.leagueId, t.seasonYear)]
)

export const mnsPickAssignments = gameSchema.table(
  'pick_assignments',
  {
    id: text('id').primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    seasonYear: integer('season_year').notNull(),
    round: integer('round').notNull(),
    pickInRound: integer('pick_in_round').notNull(),
    overallPick: integer('overall_pick').notNull(),
    currentTeamId: text('current_team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    originalTeamId: text('original_team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    originalTeamName: text('original_team_name').notNull(),
    originalTeamAbbrev: text('original_team_abbrev').notNull(),
    playerId: text('player_id'),
    playerName: text('player_name'),
    isKeeperSlot: boolean('is_keeper_slot').notNull().default(false),
    pickedAt: timestamp('picked_at'),
    pickedBy: text('picked_by'),
    wasTraded: boolean('was_traded').notNull().default(false),
    tradeHistory: jsonb('trade_history')
      .$type<PickTradeHistoryEntry[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_mns_pick_assignments_league').on(t.leagueId),
    index('idx_mns_pick_assignments_current_team').on(t.currentTeamId),
    index('idx_mns_pick_assignments_league_season').on(t.leagueId, t.seasonYear),
  ]
)

// FUTURE pick ownership, lazily materialized: a pick with no row here
// still belongs to its original team. A row exists only once a pick
// has been traded (or re-traded). Keyed by (season, round, original
// team) — the identity a pick keeps no matter how many hands it
// passes through.
export const mnsFuturePicks = gameSchema.table(
  'future_picks',
  {
    id: text('id').primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    seasonYear: integer('season_year').notNull(),
    round: integer('round').notNull(),
    originalTeamId: text('original_team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    currentTeamId: text('current_team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    unique('mns_future_picks_identity_key').on(t.leagueId, t.seasonYear, t.round, t.originalTeamId),
    index('idx_mns_future_picks_owner').on(t.currentTeamId),
  ]
)

export const mnsRookieDraftPicks = gameSchema.table(
  'rookie_draft_picks',
  {
    id: text('id').primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    seasonYear: integer('season_year').notNull(),
    round: integer('round').notNull(),
    pickInRound: integer('pick_in_round').notNull(),
    overallPick: integer('overall_pick').notNull(),
    teamId: text('team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    playerId: text('player_id'),
    playerName: text('player_name'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_mns_rookie_picks_league').on(t.leagueId),
    index('idx_mns_rookie_picks_team').on(t.teamId),
  ]
)

export const mnsDraftHistory = gameSchema.table(
  'draft_history',
  {
    id: text('id').primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    seasonYear: integer('season_year').notNull(),
    picks: jsonb('picks').$type<DraftPick[]>().notNull().default(sql`'[]'::jsonb`),
    keepers: jsonb('keepers').$type<DraftPick[]>().notNull().default(sql`'[]'::jsonb`),
    redshirtPlayers: text('redshirt_players').array().notNull().default(sql`'{}'::text[]`),
    internationalPlayers: text('international_players').array().notNull().default(sql`'{}'::text[]`),
    completedAt: timestamp('completed_at').notNull(),
    completedBy: text('completed_by').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('idx_mns_draft_history_league').on(t.leagueId)]
)

// ============================================================================
// SCHEDULE — games, league_weeks, matchups
// ============================================================================

export const mnsGames = gameSchema.table(
  'games',
  {
    id: text('id').primaryKey(),
    seasonYear: integer('season_year').notNull(),
    gameDate: text('game_date').notNull(),
    awayTeam: text('away_team').notNull(),
    homeTeam: text('home_team').notNull(),
    isCupGame: boolean('is_cup_game').notNull().default(false),
    notes: text('notes'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('idx_mns_games_date').on(t.gameDate, t.seasonYear)]
)

export const mnsLeagueWeeks = gameSchema.table(
  'league_weeks',
  {
    id: text('id').primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    seasonYear: integer('season_year').notNull(),
    weekNumber: integer('week_number').notNull(),
    matchupWeek: integer('matchup_week').notNull(),
    startDate: text('start_date').notNull(),
    endDate: text('end_date').notNull(),
    isTradeDeadlineWeek: boolean('is_trade_deadline_week').notNull().default(false),
    label: text('label'),
  },
  (t) => [index('idx_mns_league_weeks_league_season').on(t.leagueId, t.seasonYear)]
)

export const mnsMatchups = gameSchema.table(
  'matchups',
  {
    id: text('id').primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    seasonYear: integer('season_year').notNull(),
    matchupWeek: integer('matchup_week').notNull(),
    homeTeamId: text('home_team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    awayTeamId: text('away_team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    homeScore: numeric('home_score'),
    awayScore: numeric('away_score'),
    // scheduled → live (week underway) → final (week over, records
    // counted). Written by the scoring pass, read by standings.
    status: text('status').notNull().default('scheduled'),
    // Playoff games score like any week but never bank into the
    // regular-season record; label names the round.
    isPlayoff: boolean('is_playoff').notNull().default(false),
    label: text('label'),
    // Category-by-category detail from computeMatchupResult, so the
    // matchup page can show WHY someone is up 6-3 without recomputing.
    result: jsonb('result').$type<Record<string, unknown> | null>(),
  },
  (t) => [
    index('idx_mns_matchups_league_week').on(t.leagueId, t.matchupWeek),
  ]
)

// Every roster move the league ever makes, in one place with a clock
// on it: instant pickups, waiver grants, executed trades. The
// transactions page reads THIS; the source tables stay authoritative
// for their own mechanics.
export const mnsTransactions = gameSchema.table(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // 'add_drop' | 'waiver' | 'trade'
    teamIds: text('team_ids').array().notNull().default(sql`'{}'::text[]`),
    // Human-readable pieces: { added, dropped, teamName, assets, ... }
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('idx_mns_transactions_league_time').on(t.leagueId, t.createdAt)]
)

// One row per notification batch that must fire exactly once — the
// lineup warning keys on (league, kind, day) so a 20-minute tick can
// check freely and send once.
export const mnsNotifyLog = gameSchema.table(
  'notify_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    dateKey: text('date_key').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [unique('mns_notify_log_once_key').on(t.leagueId, t.kind, t.dateKey)]
)

// One waiver claim = one move in a team's QUEUE for a clearing day
// (rank orders the queue). Clearing runs like a snake draft: round one
// takes every team's top claim in priority order, round two reverses,
// and so on until the queues are empty — then the line re-forms from
// tonight's grants (most recent grant to the back). add_player_ids is
// still an ordered preference list within one claim, so being sniped
// costs that player, not the slot.
export const mnsWaiverClaims = gameSchema.table(
  'waiver_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    // Eastern date (YYYY-MM-DD) this claim clears on.
    clearsOn: text('clears_on').notNull(),
    // Position in the team's queue for that day, 1-based.
    rank: integer('rank').notNull().default(1),
    addPlayerIds: text('add_player_ids').array().notNull().default(sql`'{}'::text[]`),
    // Optional since rosters may run short (a straight drop leaves a
    // hole to fill add-only).
    dropPlayerId: text('drop_player_id').references(() => mnsPlayers.id),
    status: text('status').notNull().default('pending'), // pending|granted|failed|withdrawn
    grantedPlayerId: text('granted_player_id'),
    failureReason: text('failure_reason'),
    processedAt: timestamp('processed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_mns_waiver_claims_team_day').on(t.teamId, t.clearsOn),
    index('idx_mns_waiver_claims_league_day').on(t.leagueId, t.clearsOn),
  ]
)

// One player's real (or simulated) box line for one day. Raw components
// only — ratio categories (FG%, A/TO) are computed at aggregation time,
// never stored. Upserts key on (league, player, date) so re-ingesting a
// corrected ESPN box is idempotent.

// ============================================================================
// FEES
// ============================================================================

export const mnsKeeperFees = gameSchema.table(
  'keeper_fees',
  {
    id: text('id').primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    seasonYear: integer('season_year').notNull(),
    franchiseTagFees: numeric('franchise_tag_fees').notNull().default('0'),
    redshirtFees: numeric('redshirt_fees').notNull().default('0'),
    franchiseTagCount: integer('franchise_tag_count').notNull().default(0),
    redshirtCount: integer('redshirt_count').notNull().default(0),
    lockedAt: timestamp('locked_at').notNull(),
    lockedBy: text('locked_by').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [index('idx_mns_keeper_fees_league').on(t.leagueId)]
)

export const mnsTeamFees = gameSchema.table(
  'team_fees',
  {
    id: text('id').primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    seasonYear: integer('season_year').notNull(),
    franchiseTagFees: numeric('franchise_tag_fees').notNull().default('0'),
    redshirtFees: numeric('redshirt_fees').notNull().default('0'),
    firstApronFee: numeric('first_apron_fee').notNull().default('0'),
    secondApronPenalty: numeric('second_apron_penalty').notNull().default('0'),
    unredshirtFees: numeric('unredshirt_fees').notNull().default('0'),
    feesLocked: boolean('fees_locked').notNull().default(false),
    lockedAt: timestamp('locked_at'),
    feeTransactions: jsonb('fee_transactions').notNull().default(sql`'[]'::jsonb`),
    totalFees: numeric('total_fees').notNull().default('0'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    unique('mns_team_fees_season_key').on(t.leagueId, t.teamId, t.seasonYear),
    index('idx_mns_team_fees_league').on(t.leagueId),
    index('idx_mns_team_fees_team').on(t.teamId),
  ]
)

// ============================================================================
// TRADES
// ============================================================================

export const mnsTradeProposals = gameSchema.table(
  'trade_proposals',
  {
    id: text('id').primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    seasonYear: integer('season_year').notNull(),
    proposedByTeamId: text('proposed_by_team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    proposedByUserId: text('proposed_by_user_id')
      .notNull()
      .references(() => users.id),
    status: text('status').notNull().default('pending'),
    assets: jsonb('assets').$type<TradeAsset[]>().notNull().default(sql`'[]'::jsonb`),
    involvedTeamIds: text('involved_team_ids').array().notNull().default(sql`'{}'::text[]`),
    note: text('note'),
    expiresAt: timestamp('expires_at'),
    executedAt: timestamp('executed_at'),
    executedBy: text('executed_by'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_mns_trade_proposals_league').on(t.leagueId),
    index('idx_mns_trade_proposals_status').on(t.status),
  ]
)

export const mnsTradeProposalResponses = gameSchema.table(
  'trade_proposal_responses',
  {
    id: text('id').primaryKey(),
    proposalId: text('proposal_id')
      .notNull()
      .references(() => mnsTradeProposals.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    respondedBy: text('responded_by'),
    respondedAt: timestamp('responded_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_mns_trade_responses_proposal').on(t.proposalId),
    index('idx_mns_trade_responses_team').on(t.teamId),
  ]
)

// ============================================================================
// WAGERS
// ============================================================================

export const mnsWagers = gameSchema.table(
  'wagers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    seasonYear: integer('season_year').notNull(),
    proposerTeamId: text('proposer_team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    opponentTeamId: text('opponent_team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    amount: numeric('amount').notNull(),
    settlementDate: text('settlement_date'),
    status: text('status').notNull().default('pending'),
    proposedAt: timestamp('proposed_at').defaultNow().notNull(),
    proposedBy: text('proposed_by').notNull(),
    respondedAt: timestamp('responded_at'),
    respondedBy: text('responded_by'),
    settledAt: timestamp('settled_at'),
    winnerTeamId: text('winner_team_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_mns_wagers_league').on(t.leagueId),
    index('idx_mns_wagers_proposer').on(t.proposerTeamId),
    index('idx_mns_wagers_opponent').on(t.opponentTeamId),
  ]
)

// ============================================================================
// WATCHLISTS
// ============================================================================

export const mnsWatchlists = gameSchema.table(
  'watchlists',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => mnsTeams.id, { onDelete: 'cascade' }),
    playerIds: text('player_ids').array().notNull().default(sql`'{}'::text[]`),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('idx_mns_watchlists_league_team').on(t.leagueId, t.teamId)]
)

// ============================================================================
// STATS
// ============================================================================

// Keyed by player_id (FK to mns_players). One projected-stats row per
// player per season; PK includes season_year to support multi-season
// projections cohabiting if we ever need them. seasonYear default
// kept for backwards-compat with the WNBA scraper output.


// ============================================================================
// PROSPECTS
// ============================================================================

export const mnsProspects = gameSchema.table(
  'prospects',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    rank: integer('rank').notNull(),
    player: text('player').notNull(),
    school: text('school').notNull().default(''),
    year: text('year').notNull().default(''),
    position: text('position').notNull().default(''),
    positionRank: integer('position_rank'),
    height: text('height'),
    weight: integer('weight'),
    age: integer('age'),
    hometown: text('hometown'),
    highSchool: text('high_school'),
    draftYear: integer('draft_year'),
    draftProjection: text('draft_projection'),
    scoutingReport: text('scouting_report'),
    strengths: text('strengths').array(),
    weaknesses: text('weaknesses').array(),
    playerComparison: text('player_comparison'),
    sport: text('sport').notNull().default(sport.key),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [index('idx_mns_prospects_rank').on(t.rank)]
)

// ============================================================================
// PORTFOLIO — prize pool wallet tracking
// ============================================================================

export const mnsPortfolios = gameSchema.table(
  'portfolios',
  {
    id: text('id').primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    walletAddress: text('wallet_address').notNull(),
    usdInvested: numeric('usd_invested').notNull().default('0'),
    cachedEthBalance: numeric('cached_eth_balance'),
    cachedUsdValue: numeric('cached_usd_value'),
    cachedEthPrice: numeric('cached_eth_price'),
    lastUpdated: timestamp('last_updated').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [index('idx_mns_portfolios_league').on(t.leagueId)]
)

// ============================================================================
// PLAYOFFS
// ============================================================================

export const mnsPlayoffBrackets = gameSchema.table(
  'playoff_brackets',
  {
    id: text('id').primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    seasonYear: integer('season_year').notNull(),
    bracket: jsonb('bracket').notNull(),
    consolation: jsonb('consolation'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [index('idx_mns_playoff_brackets_league').on(t.leagueId)]
)

export const mnsPrizePayouts = gameSchema.table(
  'prize_payouts',
  {
    id: text('id').primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    seasonYear: integer('season_year').notNull(),
    zone: text('zone').notNull(),
    totalPool: numeric('total_pool').notNull(),
    payouts: jsonb('payouts').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('idx_mns_prize_payouts_league').on(t.leagueId)]
)

// ============================================================================
// AUDIT — importer log + phase transitions
// ============================================================================

export const mnsLeagueImports = gameSchema.table(
  'league_imports',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    importer: text('importer').notNull(),
    ranBy: text('ran_by').notNull().references(() => users.id),
    ranAt: timestamp('ran_at').defaultNow().notNull(),
    fileHash: text('file_hash'),
    resultSummary: jsonb('result_summary'),
  },
  (t) => [index('idx_mns_league_imports_league').on(t.leagueId)]
)

export const mnsPhaseTransitions = gameSchema.table(
  'phase_transitions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    leagueId: text('league_id')
      .notNull()
      .references(() => mnsLeagues.id, { onDelete: 'cascade' }),
    fromPhase: text('from_phase').$type<LeaguePhase>(),
    toPhase: text('to_phase').$type<LeaguePhase>().notNull(),
    triggeredBy: text('triggered_by').notNull().references(() => users.id),
    triggeredAt: timestamp('triggered_at').defaultNow().notNull(),
    preconditionsMet: jsonb('preconditions_met'),
  },
  (t) => [index('idx_mns_phase_transitions_league').on(t.leagueId)]
)

// ── Hub contract views ─────────────────────────────────────────────
// The hub (mns-fantasy) lists a member's leagues across every game by
// reading two views with one shape from each game schema:
//   <game>.hub_leagues  (id, name, game_slug, format, created_at)
//   <game>.hub_members  (league_id, user_id, team_name, joined_at)
// They live HERE, in the drizzle schema, so a push creates them with
// the tables and never drops them as strangers — which is how the
// WNBA pair went missing after being applied once by hand.
export const hubLeagues = gameSchema.view('hub_leagues').as((qb) =>
  qb
    .select({
      id: mnsLeagues.id,
      name: mnsLeagues.name,
      game_slug: mnsLeagues.gameSlug,
      format: sql<string>`'season'::text`.as('format'),
      created_at: mnsLeagues.createdAt,
    })
    .from(mnsLeagues)
)

export const hubMembers = gameSchema.view('hub_members').as((qb) =>
  qb
    .select({
      league_id: mnsTeams.leagueId,
      user_id: mnsTeamOwners.userId,
      team_name: sql<string>`${mnsTeams.name}`.as('team_name'),
      joined_at: sql<Date>`${mnsTeamOwners.createdAt}`.as('joined_at'),
    })
    .from(mnsTeamOwners)
    .innerJoin(mnsTeams, eq(mnsTeams.id, mnsTeamOwners.teamId))
    .where(isNotNull(mnsTeamOwners.userId))
)
