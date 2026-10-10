# Setting up a league — the order of operations

Written Oct 9 2026 after setting up The Money Never Sleeps (NBA) by hand.
This is the sequence the app expects, what each step writes, and what
bit us. The in-app Commissioner setup checklist (`CommissionerChecklist`)
must say the same thing in the same order; change both together.

Vocabulary: a Commissioner runs a league. Keeper season = owners choose
keepers. Rookie draft = the league's own draft of this year's class.
Veteran draft = the main 13-round draft run by the hub.

## The sequence

| # | Step | Where | What it writes | Done when |
|---|------|-------|----------------|-----------|
| 0 | Create the league (name only) | `/create` | league row from the sport preset, `leaguePhase = keeper_season`, the sport's pool linked automatically | league exists |
| 1 | Starting point | Home → checklist (a small link once chosen) | `config.setup` (`entryPhase`, `rosterSource`). Changeable until the season starts | chosen |
| 2 | Teams | `/lm/teams` | teams (names first; owner emails optional; invites HELD until "Send invites"); Edit / Remove per team | every team present |
| 3 | Settings | `/lm/league` (done once saved: `config.setup.settingsSaved`) | season dates from the sport's real calendar (fold light weeks), roster shape, aprons toggle + suggested ladder, fees, prize pool, scoring; the rest under Advanced | decisions made |
| 4 | Rosters (imports only) | `/lm/rosters` | `players.team_id`, slot, and the one "Rd" box: `4` = last year's round (costs one less), `1.4` = the rookie slot of a rookie redshirted last year (priced by the rookie table). Row shows "keeps at Rd N" / "no round yet". No roster limits before the season | every rostered player priced |
| 5 | Rookie draft (keeper leagues) | `/lm/rookie-picks` | board: an order per round AS THE SLOTS WERE BEFORE TRADES; traded picks change hands on the board (`original_team_id` stays). Every pick, live or recorded, stamps `rookieDraftInfo` + `isRookie` and puts the player on the picking team | every pick has a player |
| 6 | Keepers | owners on **My Team** (plan per player: Keep / Drop / Redshirt / Int Stash, saved ideas, submit); the commissioner locks on `/keepers` | `rosters` row per team (entries, summary, status, savedScenarios); lock keeps KEEP (stacked round → `draft_round`), parks REDSHIRT / INT_STASH, releases the rest, `leaguePhase = draft`, `keepersLocked` | locked |
| 7 | Veteran draft | `/lm/draft-setup` → hub draft | hub board; sync writes `team_id` and `draft_round` per pick | hub draft complete |
| 8 | Start the season | Home | `seasonStartedAt`, `leaguePhase = regular_season`; from then the tick runs lineups, scoring, waivers, dues | started |

Year turn (commissioner, from the champion phase): `POST rollover` —
season year +1, cap ladder grows by the annual percent, every player's
`draft_round` becomes `keeper_prior_year_round`, a redshirted rookie
carries her slot with no second redshirt, free agents carry nothing,
phase lands on `rookie_draft`. Nobody types rounds in year two.

## Scenarios (step 1) and which steps apply

- **Brand new**: 0 → 2 → 3 → 7 → 8. Pool only, no rounds.
- **Importing, before the rookie draft**: 0 → 1 → 2 → 3 → 4 → 5 (run live) → 6 → 7 → 8.
- **Importing, rookie draft already happened**: same, but 5 is RECORDED (any order, until the season starts). This is The Money Never Sleeps.
- **Importing mid-season**: 0 → 1 → 2 → 3 → 4 → 8.

## Pricing, in one place

- Rookie in her draft year, or redshirted last year: her slot through
  `config.keeper.rookieRoundMap` (NBA: 1.1–1.3 → 4, 1.4–1.6 → 5,
  1.7–1.9 → 6, 1.10–1.12 → 7, rounds 2+ → 10). Redshirt on the table
  only in the draft year.
- Everyone else: last year's round minus one (floor 1). First round-1
  keeper is free; extra round-1 keepers are franchise tags taking 2, 3…
- Undrafted pickups: counted as the last round at the year turn.
- No round of any kind: unkeepable (`fallbackRound` is null) — the
  Rosters row says "no round yet" so it is caught before keepers open.

## What bit us on The Money Never Sleeps (don't repeat)

1. Rounds were typed for rookies too, so 72 players sat at "Rd 13 →
   costs 12". Rookies are never priced from the Rd box; the board stamps
   them. (Fixed Oct 9.)
2. The rookie board could not record a draft that already happened, nor
   a traded pick, nor a round 2 ordered differently from round 1. (Fixed
   Oct 9.)
3. Last year's owner labels (PJio, Twin, Bad…) did not match this year's
   team names; the cross-check matched players, not names. Ask for the
   owner → team map up front.
4. International stashes are not in the pool (ESPN rosters only): 13 of
   Rick's 14 cannot be rostered. OPEN.
5. Players ESPN shows on no roster (retired, unsigned) are not in the
   pool either: Chris Paul, Lonzo Ball, D'Angelo Russell… OPEN, matters
   only for history.

## Gaps on the path, verified Oct 9 2026

- **Scenario does not set the phase.** Only the rollover ever writes
  `leaguePhase = rookie_draft`; a new league is created in
  `keeper_season` whatever the starting point. A first-year league can
  RECORD its rookie draft but cannot RUN one live (the `pick` action
  requires the rookie_draft phase).
- **The veteran draft ignores keepers.** The hub draft gives every team
  `config.draft.rounds` picks and only excludes rostered players from
  the pool: a team keeping 8 would draft 13 more. Keepers must enter the
  hub draft as filled slots at their stacked rounds, so the board shows
  which rounds are open.
- ~~Keeper plans are not built.~~ Built Oct 10: the MNS flow on My Team
  (`KeeperPlanner`, rules in `src/rules/keeperPlan.ts`); the lock reads
  each team's submitted plan. Still open: the hub draft must take keepers
  as filled rounds.
- ~~The checklist measures the wrong things.~~ Fixed Oct 9: every stage
  has one measured number (teams with owners, settings saved, players
  unpriced, picks recorded, teams submitted, draft status) and Keepers
  is its own stage before the veteran draft.
- **Start the season checks nothing** but the commissioner and "not
  already started".
