---
type: "query"
date: "2026-09-04T04:18:05.823005+00:00"
question: "can you look online for fpl strategies that the solver should maybe incorporate"
contributor: "graphify"
outcome: "useful"
source_nodes: ["exactOptimizer.ts", "weeklyLineup.ts", "timeline.ts", "finance.ts", "captain.ts", "objective.ts", "value.ts", "fixtureAdjustment.ts"]
---

# Q: can you look online for fpl strategies that the solver should maybe incorporate

## Answer

The main missing strategy is multi-period transfer-path optimization: jointly choose weekly squads while accounting for up to five banked free transfers, four-point hits, selling prices, cash in the bank, and chip rules. The app already replays those rules in its chip timeline, but exact squad optimization remains a static horizon squad. Next priorities are joint chip timing and aligning the exact optimizer's captain objective with the weekly lineup engine's vice-captain DNP promotion. A modest future-week confidence decay and flexibility tie-breakers may help, but robust/scenario optimization is not clearly superior in published tests. Keep ownership/differentials, opposing-player rules, and exact autosub enumeration out of the default expected-points objective because they mostly alter variance or runtime rather than expected points.

## Outcome

- Signal: useful

## Source Nodes

- exactOptimizer.ts
- weeklyLineup.ts
- timeline.ts
- finance.ts
- captain.ts
- objective.ts
- value.ts
- fixtureAdjustment.ts