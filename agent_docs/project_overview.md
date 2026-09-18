# Project Overview

## Purpose

FPL Terminal is a local-first, zero-database Fantasy Premier League workstation
and live mini-league command center. Planner features calculate deterministic
expected points (xP), legal squads, weekly lineups, and transfer options;
Leagues features combine official standings, live scoring, match activity, and
manager impact.

## Scope

The Planner is available at `/` and `/terminal`; Leagues is at `/leagues`.
Server routes fetch and normalize official FPL data, enrich it with historical
and lineup evidence, and expose projections, optimization, and live-league
calculations. Client state is held in Zustand with local-storage persistence;
the project has no database or official FPL submission workflow.

## Architecture

The Next.js App Router provides pages and API boundaries. Domain calculations
live in `lib/`, shared contracts in `types/`, UI composition in `components/`,
and persisted client state in `store/`; reviewed and generated inputs live in
`data/`. See `project_structure.md` for the module map and integration edges.

## Main Workflows

Planner data flows from FPL bootstrap and fixtures through normalization,
historical/lineup enrichment, projections, and exact optimization before being
shown in the squad workbench. Leagues data flows from standings, picks, live
elements, and fixtures through official scoring/substitution calculations into
the standings, match centre, feed, and live-squad views.

## Major Decisions

- Keep facts, evidence, and deterministic estimates separate in the data model.
- Store prices and budgets as integer tenths and enforce squad/lineup legality
  in shared `lib/squad` helpers.
- Use the deterministic HiGHS MILP solver for exact squad and XI optimization;
  UI components consume domain helpers rather than reimplementing rules.
