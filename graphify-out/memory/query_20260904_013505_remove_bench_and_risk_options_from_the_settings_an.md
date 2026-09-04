---
type: "query"
date: "2026-09-04T01:35:05.869979+00:00"
question: "remove bench and risk options from the settings and have one optimizer calculation that just optimizes for xp for the given horizon"
contributor: "graphify"
outcome: "useful"
source_nodes: ["exactOptimizer.ts", "weeklyLineup.ts", "optimizer.ts"]
---

# Q: remove bench and risk options from the settings and have one optimizer calculation that just optimizes for xp for the given horizon

## Answer

Expanded from original query via graph vocab: [optimizer, objective, points, horizon, weekly, lineup, captain, autosub, bench, risk, squad, score]. Removed the risk and bench controls and request fields from the main optimizer settings. Replaced the risk-adjusted fixed-XI objective with raw gameweek xP for a separate legal XI and captain in every gameweek of the selected horizon. Kept squad budget, positions, club limits, locks, exclusions, and the internal Bench Boost calculation. Added a rotating-lineup regression test and updated API and browser tests. Full unit tests, typecheck, lint, browser tests, and production build pass; build retains pre-existing dynamic filesystem tracing warnings.

## Outcome

- Signal: useful

## Source Nodes

- exactOptimizer.ts
- weeklyLineup.ts
- optimizer.ts