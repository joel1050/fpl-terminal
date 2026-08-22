<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# FPL Terminal agent guide

FPL Terminal is a local-first Fantasy Premier League workstation. It fetches live FPL data on the server, enriches it with historical and manually reviewed availability inputs, calculates deterministic projections, optimizes a legal 15-player squad, and picks a legal weekly XI with an ordered bench and captaincy. DeepSeek explains or proposes actions, but it is optional and must never become the source of quantitative results or mutate state directly.

## Start here

Use Node 20.9 or newer and the npm scripts in `package.json`:

```bash
npm install
cp .env.example .env.local
npm run dev
```

Before finishing a change, run the smallest focused test that covers it, then the checks appropriate to its risk:

```bash
npm test
npm run typecheck
npm run lint
npm run test:e2e
npm run build
```

The Playwright suite intercepts external data, so it should not require live FPL or DeepSeek access. `DEEPSEEK_API_KEY` is optional and must remain server-side.

## Code map

- `app/` contains the Next.js App Router pages and server routes. `/api/fpl/bootstrap` is the main browser data boundary; it fetches, normalizes, enriches, and projects the player universe.
- `components/terminal/TerminalApp.tsx` composes the workstation UI: Player Universe, the unified Squad Builder, and AI Analyst. Keep calculations out of this component when a domain helper already exists.
- `store/terminalStore.ts` owns browser state and local-storage persistence. Squad and weekly-lineup mutations must stay atomic: invalid changes return false and leave state unchanged.
- `lib/fpl/` handles upstream requests, validation, caching, freshness, and normalization.
- `lib/historical/` loads and maps prior-season evidence.
- `lib/availability/` combines RotoWire predicted lineups and injury labels with historical starts.
- `lib/projections/` owns expected minutes, fixture adjustment, clean-sheet odds, regressed per-90 rates, scenario-weighted xP, confidence, and risk.
- `lib/squad/` owns squad legality, budget checks, weekly XI enumeration, autosubs, captaincy, and manual-lineup validation.
- `lib/optimizer/` owns deterministic squad optimization. The app-facing exact path lives in `exactOptimizer.ts`; do not replace it with an LLM or an unverified heuristic.
- `lib/analysis/` owns squad summaries, transfer suggestions, weaknesses, and simulations.
- `lib/ai/` defines the DeepSeek tools, schemas, prompts, and action proposal boundary.
- `types/` contains shared domain contracts. Extend these contracts rather than creating parallel UI-only shapes for the same data.
- `data/manual/` contains reviewed inputs such as team strengths and RotoWire identity mappings. `data/generated/` contains ingestion output.
- `scripts/` contains manual historical and RotoWire ingestion commands.
- `tests/` mirrors the domain areas; `tests/fixtures/` is the stable browser-test universe.

## Data flow

```text
FPL APIs + fixtures
        ↓
lib/fpl normalization ── historical bundle ── RotoWire/manual evidence
        ↓
player selection probabilities and scenario-weighted projections
        ↓
optimizer / weekly lineup / analysis engines
        ↓
Zustand state and TerminalApp
        ↓
optional DeepSeek explanations and proposed actions
```

Keep facts, estimates, and explanations separate. Live price, ownership, status, fixtures, and deadlines come from FPL. Historical starts and RotoWire reporting are evidence. Expected minutes, xP, strength, risk, confidence, and nailed ratings are model estimates and should remain traceable to their inputs.

## Domain invariants

- Store money as integer tenths: `105` means £10.5m. Convert only for display.
- A legal squad has 15 players in a 2 GK / 5 DEF / 5 MID / 3 FWD split, stays within £100.0m, and has no more than three players from one club.
- A legal weekly XI has one goalkeeper, at least three defenders, at least two midfielders, at least one forward, one backup goalkeeper, three distinct ordered outfield substitutes, and distinct starting captain and vice-captain.
- Double Gameweeks sum every fixture in that Gameweek. Blank Gameweeks return zero. Three- and five-Gameweek totals count distinct Gameweeks rather than fixture rows.
- Weekly displayed totals use the weekly-lineup engine: starting-XI xP plus captain bonus and the labelled estimated autosub value. Do not reimplement a second total in the UI.
- Availability and expected minutes must respect injury and suspension status. Positive lineup or history evidence must not raise an unavailable player's appearance probabilities.
- Persisted lineups are derived from the squad minus the four bench players and are guarded by the Gameweek and projection fingerprint. Never silently overwrite a stale applied lineup.
- Locked players constrain optimization and cannot be removed until unlocked. The backup goalkeeper should be strongly biased toward the £4.0m tier without making incompatible locks an error.

## Change rules

Trace the existing path before adding code; shared domain fixes belong in `lib/`, not in individual UI callers. Reuse the existing validators and engines for UI, AI, and API behavior so they cannot disagree.

Preserve unrelated working-tree changes. Do not hand-edit generated snapshots to make a test pass; fix the importer or use a test fixture. Do not add a database, authentication, background updater, new dependency, or official-FPL submission path unless the task explicitly asks for it.

When changing projections, leave one deterministic test that checks the numerical behavior and its edge case. When changing persisted state, test reload and invalid-operation atomicity. When changing the roster, test 1280×720 desktop visibility and the 390×844 mobile path. Keep the terminal palette, compact typography, thin dark scrollbars, centered Starting XI rows, and separate bench rail unless the task changes that design.

## Manual data refreshes

```bash
npm run data:ingest   # historical inputs
npm run data:lineups  # RotoWire EPL predicted lineups and injuries
```

RotoWire is manually refreshed by design. Its importer must reject partial pages, ambiguous mappings, or teams without 11 distinct starters rather than replacing a good snapshot with incomplete data. Put reviewed name corrections in `data/manual/rotowire-fpl-mappings.json` and team-strength changes in `data/manual/team-strengths.json`.
