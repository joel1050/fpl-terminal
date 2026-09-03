# FPL Terminal

FPL Terminal is a local-first quantitative Fantasy Premier League workstation. You build or paste a squad, then inspect legality, budget, expected points, minutes security, fixture context, weak links, replacements, and transfer simulations.

## Setup

```bash
npm install
npm run data:ingest
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Historical ingestion is a local preparation step; if its upstream source is unavailable, the live-data shell can still start and reports the missing snapshot instead of inventing player data.

The stack is Next.js App Router, React, strict TypeScript, Tailwind CSS, Zustand, TanStack Query, Zod, Vitest, and Playwright. The MVP deliberately has no database or authentication dependency.

## Commands

```bash
npm run dev          # local development server
npm run data:ingest  # download and normalize historical inputs
npm run data:lineups # manually refresh the RotoWire EPL lineup snapshot
npm test             # deterministic domain tests
npm run test:e2e     # Playwright browser acceptance tests
npm run typecheck    # strict TypeScript check
npm run lint         # ESLint
npm run build        # production build
```

The E2E suite intercepts the FPL data boundaries with clearly labelled test fixtures. It does not alter production data or require a live FPL account.

## Architecture

The app keeps facts, estimates, and explanations separate:

1. Server-side FPL adapters fetch `bootstrap-static`, fixtures, player summaries, and live-gameweek data, with cache freshness and an explicit unavailable state.
2. The normalization layer converts raw FPL payloads into the `Player`, `Fixture`, and team-strength contracts used by the rest of the app. Price stays in integer tenths (`105` means £10.5m) so budget checks do not depend on floating-point arithmetic.
3. Historical inputs are downloaded from the Vaastav Fantasy Premier League repository and normalized into compact local files. Current-season live FPL data remains the source of truth for price, availability, ownership, fixtures, deadlines, and current statistics.
4. Projection, validation, budget, optimizer, weakness, replacement, and simulation engines are deterministic application code. They enforce the 15-player squad rules, £100.0m budget, position limits, three-player club limit, locked players, and legal starting-XI constraints without asking the LLM to calculate.
Squad preferences and working state are stored in browser local storage. There is no database, authentication, or cloud account integration in this MVP.

## Live and historical data

Live requests go through the Next.js server boundary rather than directly from the browser. The app exposes freshness and an unavailable state; a previous local snapshot may be used only when it is explicitly identified as stale. It never presents fallback values as current FPL facts.

`npm run data:ingest` uses the 2025/26 Vaastav dataset for historical minutes, starts, FPL points, scoring events, bonus/BPS, ICT, and available xG/xA or defensive-contribution fields. Current 2026/27 data comes from the live FPL endpoints and can supplement a historical mapping, but it does not replace live values. Historical player IDs are matched by stable codes where possible, then by normalized name and club context; unresolved mappings are marked lower confidence.

`npm run data:lineups` performs one manual fetch of RotoWire's public EPL lineups page, maps its players to the current FPL universe, and writes the source snapshot, resolved mappings, and unresolved report under `data/generated`. The importer stores fixture teams, predicted or confirmed starters, and the published `QUES`, `OUT`, or `SUS` availability labels with stable RotoWire profile IDs. It validates that every team has exactly 11 distinct starters and refuses to replace the snapshot when the page is partial or its markup has changed. Add reviewed identity corrections to `data/manual/rotowire-fpl-mappings.json`; unconfirmed or ambiguous names stay unresolved.

## Projection model

Projection Model v0.1 is an internally constructed, transparent expected-points estimate. The weekly selection model combines RotoWire's predicted XI and injury labels with historical starts and live FPL availability to produce `P(start)`, `P(cameo)`, confidence, and a 1–5 nailed rating. Expected points then weight separate 80-minute start, 20-minute cameo, and no-show scenarios before adding fixture context and the usual appearance, attacking, clean-sheet, save, bonus, and defensive-contribution components. Doubles sum both fixtures, while three- and five-week totals count distinct Gameweeks.

This is not Opta, official FPL prediction, or a commercial bookmaker model. New signings, promoted players, role changes, injuries, and early-season minutes carry material uncertainty; confidence and risk are shown alongside the estimate. Fixture difficulty is an input, not the whole model.

## Known limitations

- The MVP has no authentication, database, FPL team-account connection, or cloud persistence.
- Projection quality depends on current upstream FPL data and the available historical mapping; it is a decision aid, not a guarantee of points.
- Overseas-league history and sparse defensive-contribution samples receive conservative priors rather than fabricated precision.
- The optimizer uses deterministic bounded search suitable for a few hundred players, not a hosted MILP service.
