---
type: "query"
date: "2026-09-04T01:12:57.019168+00:00"
question: "evaluate the optimizer algorithm used in this app, does it actually maximize points scored"
contributor: "graphify"
outcome: "useful"
source_nodes: ["exactOptimizer.ts", "weeklyLineup.ts", "projectPlayer.ts", "bestPossibleXI.ts"]
---

# Q: evaluate the optimizer algorithm used in this app, does it actually maximize points scored

## Answer

Expanded from original query via graph vocab: [optimizer, optimize, objective, score, points, squad, lineup, captain, autosub, expected, utility, weekly]. The HiGHS MILP is exact for its custom utility, but it does not maximize the projected total displayed by the app or unknowable realized FPL points. It fixes one XI and bench across a multi-gameweek horizon, applies risk/confidence scaling and heuristic bench weights, and omits vice-captain and exact autosub value; the UI later re-optimizes the XI per gameweek and adds captain and autosub estimates. A synthetic three-gameweek counterexample produced 676 displayed xP for the solver squad versus 680 for another legal squad. The single-gameweek bestPossibleXI routine is exact for raw projected XI plus captain bonus, excluding autosubs by design. The focused optimizer and lineup tests passed, but no end-to-end optimizer backtest against alternative legal squads exists.

## Outcome

- Signal: useful

## Source Nodes

- exactOptimizer.ts
- weeklyLineup.ts
- projectPlayer.ts
- bestPossibleXI.ts