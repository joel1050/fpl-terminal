# Project Structure

## Directory Layout

- `app/` — App Router pages and server API routes.
- `components/` — Planner and Leagues UI components.
- `lib/` — projections, optimization, squad rules, league scoring, analysis,
  availability, historical data, and FPL clients.
- `store/` — Zustand terminal state and local persistence.
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
