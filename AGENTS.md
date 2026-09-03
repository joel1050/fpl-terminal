<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# FPL Terminal Agent Guide

FPL Terminal is a local-first, zero-database Fantasy Premier League quantitative workstation and live mini-league command center. It fetches live FPL data via server routes, enriches it with historical and manually reviewed availability inputs, calculates deterministic expected points (xP), solves legal 15-player squads using an exact MILP solver, optimizes legal weekly starting XIs with ordered benches and captaincy, and tracks live mini-league standings with real-time scoring, autosub simulation, bonus points, and match activity feeds.

---

## Two Core Workspaces

The workstation provides two top-level workspaces toggled via `WorkspaceSwitcher`:

1. **Planner (`/` or `/terminal`)**: The quantitative squad workbench.
   - **Player Universe**: Filterable, sortable player table with live prices, form, multi-gameweek projections (1GW, 3GW, 5GW, 10GW), availability confidence, and risk ratings.
   - **Player Details Modal**: Detailed player cards exposing historical performance, recent matches, and selection model evidence (RotoWire predicted XI, injury status, start rates).
   - **Squad Builder & Analysis**: 15-player pitch and bench layout with player locking, budget tracking, team rating (vs. theoretical market ceiling), exact single transfer recommendations (Pareto-optimal for xP gain vs. budget released), weakness analysis, and transfer simulation.
   - **Weekly Lineup Controls**: Formation management, starting XI selection, captain (C) and vice-captain (VC) selection, and 3-slot ordered outfield bench with backup goalkeeper.
   - **Team Import**: Imports official FPL teams by entry ID to analyze existing squads.

2. **Leagues (`/leagues`)**: The real-time mini-league command center.
   - **Live Standings**: Real-time league standings combining official pre-Gameweek totals with live match scores, deducted transfer costs (`eventTransfersCost`), automatic substitution calculations, and vice-captain promotions.
   - **Match Centre**: Live fixture status, in-progress match clocks, and provisional Bonus Points System (BPS) tracking.
   - **Live Feed**: Chronological match activity feed (goals, assists, cards, saves, bonus points, autosubs) with point delta breakdowns and snapshot diff explanations.
   - **Live Squad & Impact**: Detailed view of any league member's live XI, effective ownership (EO), and net rank impact per player.

---

## Core Philosophy: Facts, Evidence, and Estimates

Keep the three data tiers strictly separate:

- **Facts**: Live price, ownership, injury status strings, fixtures, deadlines, and raw in-season totals come directly from the official FPL API.
- **Evidence**: Prior-season match statistics (Vaastav dataset), RotoWire predicted/confirmed lineups, and published injury labels (`QUES`, `OUT`, `SUS`).
- **Estimates**: Expected minutes, scenario-weighted xP, team strengths, nailed ratings, risk scores, and confidence levels are deterministic model calculations.

---

## Start Here & Developer Commands

Requires **Node 20.9+**.

```bash
npm install
npm run dev
```

### Verification & Testing Suite

Before finishing any task, run the smallest focused test that covers your change, then the standard verification checks:

```bash
npm test             # Vitest unit/integration tests (fast: 47+ test files in <5s)
npm run typecheck    # Strict TypeScript check (tsc --noEmit)
npm run lint         # ESLint check
npm run test:e2e     # Playwright browser acceptance tests (uses mocked network fixtures)
npm run build        # Production Next.js build
```

### Data Ingestion & Backtesting

```bash
npm run data:ingest   # Download & normalize prior-season Vaastav historical data
npm run data:lineups  # Manually refresh RotoWire EPL predicted lineups & injury snapshot
```

- **Backtesting Framework** (`scripts/backtest/`): Walk-forward multi-season backtests (2022/23–2025/26) calibrated against empirical FPL outcomes (see `scripts/backtest/README.md`):
  - `npx tsx scripts/backtest/validate.ts` (reproduces `projectPlayer()` to 0.0e+0 across 9,900+ played rows)
  - `npx tsx scripts/backtest/run.ts` (variant comparisons on xP RMSE)
  - `npx tsx scripts/backtest/schedule-adjust.ts` (schedule-adjusted player form)

---

## Code Map

```text
app/
├── (routes)/
│   ├── page.tsx                     # Renders TerminalApp (Planner workspace)
│   ├── terminal/page.tsx            # Explicit terminal route
│   └── leagues/page.tsx             # Renders LeagueScreen (Live Leagues workspace)
└── api/
    ├── fpl/
    │   ├── bootstrap/route.ts       # Main data boundary: fetches, normalizes, enriches, projects players
    │   ├── entry/[id]/route.ts      # Fetches user entry history and picks
    │   ├── leagues/[id]/route.ts    # Fetches classic mini-league standings
    │   ├── live/[gameweek]/route.ts # Fetches raw live Gameweek player statistics
    │   ├── fixtures/route.ts        # Fetches Gameweek fixture schedule
    │   └── player/[id]/route.ts     # Fetches player profile & recent match history
    ├── optimizer/route.ts           # Exact full squad optimization and partial completion
    ├── best-xi/route.ts             # Computes highest-scoring legal XI ceiling within budget
    └── transfer-suggestions/route.ts# Computes Pareto-optimal single transfers

components/
├── terminal/
│   ├── TerminalApp.tsx              # Planner workstation: Player Universe & Squad Builder panels
│   └── WorkspaceSwitcher.tsx        # Navigation header switching between Planner and Leagues
└── leagues/
    ├── LeagueScreen.tsx             # Live leagues container, state synchronization, and responsive tabs
    ├── MyLeaguesPanel.tsx           # Mini-league selector
    ├── LeagueStandings.tsx          # Live standings table with sorting and rank changes
    ├── LiveGameweekPanel.tsx        # Gameweek summary, average score, and top score
    ├── MatchCentre.tsx              # Fixture tracker with match status and live BPS
    ├── LiveSquad.tsx                # Pitch view of any manager's live XI, bench, and autosubs
    ├── LiveFeed.tsx                 # Real-time event stream (goals, assists, cards, subs)
    ├── useLeaguesData.ts            # Polling hook for live standings, picks, and elements
    └── tableSort.tsx                # Table sorting primitives

lib/
├── projections/                     # Deterministic projection engine (see calculations.md)
│   ├── projectPlayer.ts             # Orchestrates projection pipeline for a player
│   ├── expectedMinutes.ts           # Expected minutes from scenario probabilities
│   ├── playerForm.ts                # In-season form blending with recency decay (decay=0.95, priorWeight=10)
│   ├── fixtureAdjustment.ts         # Opponent attack/defense ratios, venue (1.102 / 0.898), FDR base
│   ├── distributions.ts             # Clean-sheet lookup table (5x5 grid) & event distributions
│   ├── regression.ts                # Bayesian shrinkage towards position/price priors
│   ├── components.ts                # Detailed breakdown of xP components (appearance, goals, clean sheets, cards)
│   ├── risk.ts                      # Risk scoring (0-100) based on availability, minutes volatility, fixture variance
│   ├── confidence.ts                # Confidence ratings (HIGH / MEDIUM / LOW)
│   ├── value.ts & metrics.ts        # Value per million and utility functions
│   └── index.ts                     # Public projections exports
├── optimizer/                       # Exact optimization engine
│   ├── exactOptimizer.ts            # HiGHS MILP solver (WASM) for full squad optimization & completion
│   ├── bestPossibleXI.ts            # HiGHS MILP solver for theoretical legal XI scoring ceiling
│   ├── objective.ts                 # Objective function: starter utility + weighted bench + captain bonus
│   ├── candidatePool.ts             # Candidate pruning for search
│   └── beamSearch.ts & optimizer.ts # Bounded heuristic fallbacks
├── squad/                           # Squad rules and weekly lineup engine
│   ├── rules.ts & constraints.ts    # Squad structure (15 players, 2/5/5/3) & club limits (<=3)
│   ├── validation.ts & budget.ts    # Legality checks, price tenths calculations, budget feasibility
│   ├── weeklyLineup.ts              # Legal XI enumeration (1/3/2/1), captaincy, ordered bench, autosub xP
│   └── captain.ts                   # Captain and vice-captain selection logic
├── leagues/                         # Live mini-league calculation engine
│   ├── calculateLiveStandings.ts    # Computes live league rows, replacing pre-GW points with live score
│   ├── calculateLiveEntry.ts        # Scores entry: official autosub rules, VC promotion, transfer hits
│   ├── fixtureStatus.ts             # Fixture state (STARTED, IN_PROGRESS, FINISHED) and player minutes
│   ├── diffLiveSnapshots.ts         # Compares live snapshots to produce human-readable explain blocks
│   ├── feedEvents.ts                # Merges and deduplicates match feed events
│   ├── leagueImpact.ts              # Effective ownership (EO) and net rank delta calculations
│   └── leagueKey.ts & display.ts    # League storage keys, formatting, and display helpers
├── analysis/                        # Squad analytics and transfer engines
│   ├── singleTransfers.ts           # Exact single transfer search with Pareto dominance
│   ├── analyzeSquad.ts              # Squad summary, strengths, structural warnings
│   ├── weakness.ts                  # Identifies underperforming or risky squad slots
│   ├── simulateChange.ts            # Simulates additions, removals, or swaps on squad metrics
│   └── context.ts                   # Shared analysis types, player universe wrappers, and utilities
├── availability/                    # Player availability and selection model
│   ├── selection.ts                 # Combines RotoWire, history, and FPL status into P(start), P(cameo), P(DNP)
│   ├── startRate.ts                 # Recursive alpha update (alpha=0.60) for current-season starts
│   ├── rotowire.ts                  # Parses RotoWire lineups and availability labels
│   ├── rotowireMapping.ts           # Maps RotoWire player identities to FPL element IDs
│   └── refreshLineups.ts            # Validates and refreshes lineup snapshots
├── historical/                      # Prior-season inputs and in-season history
│   ├── load.ts                      # Loads historical players and match stats
│   ├── enrichPlayers.ts             # Enriches players with history, consensus team strength, and priors
│   ├── inSeasonForm.ts              # In-season team attack/defense xG blending
│   ├── loadInSeasonForm.ts          # Loads live in-season player rates and appearance histories
│   └── ingest.ts                    # Ingests Vaastav raw CSV files
└── fpl/                             # Upstream FPL client, HTTP handling, and schema validation
│   ├── client.ts                    # Server-side fetchers with caching and error resilience
│   ├── normalize.ts                 # Converts FPL bootstrap/fixtures into domain models
│   ├── normalizeLeagues.ts          # Normalizes FPL entry and league payloads
│   ├── schemas.ts                   # Strict Zod schemas for all upstream endpoints
    ├── cache.ts                     # In-memory server caching with TTL
    └── http.ts                      # Standard JSON response helpers and freshness metadata

store/
└── terminalStore.ts                 # Zustand client store: atomic squad mutations, local-storage persistence,
                                     # multi-gameweek planning snapshots (gameweekPlans), and mode toggling

types/                               # Strict shared domain contracts (extend here, avoid parallel UI shapes)
├── player.ts                        # Player, CurrentStats, HistoricalStats, SelectionEvidence, PlayerSelection
├── squad.ts                         # SquadState, WeeklyLineupPlan, PersistentFPLState, SquadConstraints
├── projection.ts                    # Horizon (1|3|5|10), TeamStrength, ProjectionSummary, ProjectionComponents
├── leagues.ts                       # ManagerProfile, EntryPicks, LiveStandingsResult, LiveFeedEvent, FixtureView
└── analysis.ts                      # SingleTransferSuggestion, SquadAnalysis, SquadWeakness, SimulationResult

data/
├── manual/                          # Reviewed inputs: team-strengths.json, rotowire-fpl-mappings.json
├── generated/                       # Output of ingestion scripts (historical-players, rotowire-lineups)
└── snapshots/                       # Upstream JSON snapshots used for testing and offline development

tests/                               # Test suite mirroring domain modules
├── core/                            # Projections, calibration, fixture adjustments, priors, weekly lineup
├── optimizer/                       # Exact optimizer, best possible XI ceiling, API routes
├── leagues/                         # Live standings, entry calculation, autosubs, feed events, rank impact
├── analysis/                        # Single transfers, squad analysis, transfer suggestions route
├── data/                            # Upstream contract tests, RotoWire precedence, snapshot guards
├── store/                           # Zustand store mutations, validation atomicity, planning gameweek
├── ui/                              # Freshness indicators, player selection, responsive views
├── fixtures/                        # Stable offline mock fixtures for browser and unit tests
└── e2e/                             # Playwright browser acceptance tests
```

---

## Data Flows

### 1. Planner Data Flow

```text
FPL APIs (bootstrap-static, fixtures)
        ↓
lib/fpl normalization ── Vaastav history bundle ── RotoWire lineups & injury evidence
        ↓
lib/projections (selection probabilities, schedule-adjusted form, scenario-weighted xP)
        ↓
lib/optimizer (HiGHS MILP) / lib/squad (Weekly Lineup) / lib/analysis (Transfers)
        ↓
store/terminalStore (Zustand + local storage)
        ↓
TerminalApp UI (Player Universe, Squad Builder, Team Rating)
```

### 2. Live Leagues Data Flow

```text
FPL Mini-League Standings + Entry Picks + Live Gameweek Elements + Fixtures
        ↓
lib/leagues/calculateLiveEntry (deduplicates current GW via total_points - points,
                                sim autosubs, VC promotion, subtracts transfer hits)
        ↓
lib/leagues/calculateLiveStandings (ranks complete leagues <= 150 entries, sets live totals)
        ↓
lib/leagues/diffLiveSnapshots & feedEvents (chronological match activity stream)
        ↓
LeagueScreen UI (Standings, Match Centre with live BPS, Live Squad, Net Rank Impact)
```

---

## Domain Invariants (Critical Rules)

1. **Money as Integer Tenths**: Store all prices and budgets as integer tenths (`105` = £10.5m). Convert only for display (`priceTenths / 10`). Never use floating-point math for money.
2. **Squad Legality**: Exactly 15 players in a 2 GK / 5 DEF / 5 MID / 3 FWD split, total cost within budget (default 1000 tenths / £100.0m, or the appreciated squad budget for imported teams), and maximum 3 players per club.
3. **Weekly XI Legality**: Exactly 11 starters with 1 GK, at least 3 DEF, at least 2 MID, at least 1 FWD; 1 backup GK, 3 distinct ordered outfield substitutes, and distinct starting Captain and Vice-Captain.
4. **Gameweek Mechanics**: Double Gameweeks sum every fixture in that Gameweek. Blank Gameweeks return 0. Horizons (`1 | 3 | 5 | 10`) count distinct Gameweeks, not fixture rows.
5. **Weekly Displayed Totals**: Weekly displayed total = Starting-XI xP + Captain bonus + estimated autosub value. Always use `lib/squad/weeklyLineup.ts`; do not reimplement totals in UI components.
6. **Availability Precedence**: Negative FPL status ("i", "s", "u", "n", or 0% chance of playing) is absolute. Positive RotoWire or historical evidence **must never** raise an unavailable player's appearance probability above 0.
7. **Leagues Deduplication**: In mini-leagues, a member's pre-Gameweek total is calculated as `total_points - points` from their own history row so live points are never counted twice.
8. **Leagues Official Substitutions**: Multipliers follow official FPL rules: substitutes come on at 1x; if the captain records 0 minutes, the vice-captain receives the captain multiplier (or 3x for Triple Captain); transfer costs (`eventTransfersCost`) are deducted from the live score.
9. **Live Rank Eligibility**: Live standings ranks are calculated only when the league population is complete (no further pages) and has `<= 150` members. Incomplete or large leagues retain official FPL ranks.
10. **State Atomicity**: All mutations in `terminalStore.ts` must remain atomic. Invalid operations return `false` and leave state untouched. Persisted lineups are derived from the squad minus 4 bench players and guarded by Gameweek and projection fingerprint.
11. **Exact Optimization**: Squad optimization and ceiling calculations use the deterministic HiGHS MILP solver (`lib/optimizer/exactOptimizer.ts`). Never replace it with an LLM or unverified heuristic. Locked players constrain optimization and cannot be removed until unlocked.

---

## Agent Change Guidelines

- **Architecture Boundary**: Shared calculations and business rules belong in `lib/`, not in UI components or pages. UI components should only consume domain helpers.
- **Preserve Working Tree**: Do not discard unrelated uncommitted changes.
- **Never Hand-Edit Snapshots**: Do not hand-edit generated JSON files in `data/` or mock fixtures to make a test pass. Fix the underlying generator or normalization code.
- **No Heavy Infrastructure**: Do not introduce a database, external authentication, background cron daemon, or official FPL submission mechanism unless explicitly requested.
- **Responsive Terminal Design**: Test both desktop (1280×720) and mobile (390×844) viewports. Maintain the terminal aesthetic: dark palette, monospace accents, compact typography, thin scrollbars, clear status tones, and centered pitch layouts.
- **Math References**: When modifying projections, rates, form decay, or clean-sheet calculations, consult `calculations.md` (the comprehensive mathematical specification).
