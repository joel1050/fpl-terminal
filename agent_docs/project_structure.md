# Project Structure

## Directory Layout

- `app/` — App Router pages, server API routes, and styles. `globals.css`
  holds the design tokens; `ui.css` holds the redesign component rules.
- `components/` — Planner and Leagues UI. `shell/` holds the shared top bar,
  phone tab bar, and sheets.
- `lib/` — projections, optimization, squad rules, league scoring, analysis,
  availability, display helpers, historical data, and FPL clients.
- `store/` — Zustand terminal state and local persistence, including the
  `squadView` and `playerColumns` preferences.
- `types/` — shared domain contracts.
- `data/` — reviewed manual inputs, generated historical/lineup data, and test
  snapshots.
- `tests/` — domain, route, store, UI, fixture, and Playwright coverage.

## Modules and Responsibilities

`lib/fpl` owns upstream HTTP, schemas, caching, and normalization. Projection
and optimizer modules produce xP and legal squad/XI recommendations; `lib/squad`
owns rules and weekly mechanics; `lib/leagues` computes live rows, feed events,
autosubs, and rank impact; analysis and availability modules provide transfer
and selection evidence. Pages and components render these results without
duplicating domain calculations.

The Planner panels live in `components/terminal/`: `squad/` (KPI strip, pitch,
table, action sheet), `rail/` (decision rail, captain, alerts), `players/`
(desktop table, phone list, filter sheet), and `fixtures/` (chips and run
strip). `TerminalApp.tsx` still holds the data hooks, handlers, and
normalization. `lib/analysis/squadAlerts.ts` owns the rail's alert rules.
`lib/availability/status.ts` owns `availabilityOf`, which the squad views, the
alerts, the market filter, and start chance all use. `lib/display/` owns shared
formatting and display rules.

## Main Interfaces and Integration Boundaries

The `app/api` routes are the server boundary for FPL data, projections, and
optimization. Shared `types/` contracts connect routes, domain libraries, the
Zustand store, and UI. `data/generated` is runtime input and must remain
separate from local agent and browser artifacts.

## Tests and Supporting Assets

Tests mirror the domain modules and use stable offline fixtures and snapshots;
Playwright exercises the rendered workspaces. Historical ingestion and lineup
refresh scripts under `scripts/` produce the generated inputs consumed by the
server routes.
