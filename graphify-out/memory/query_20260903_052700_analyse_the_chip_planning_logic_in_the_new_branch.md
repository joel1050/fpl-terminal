---
type: "query"
date: "2026-09-03T05:27:00.460744+00:00"
question: "analyse the chip planning logic in the new branch for issues or a more efficient way to do it"
contributor: "graphify"
outcome: "useful"
source_nodes: ["optimizer.ts", "weeklyLineup.ts"]
---

# Q: analyse the chip planning logic in the new branch for issues or a more efficient way to do it

## Answer

Expanded from original query via graph vocab: [plan, gameweek, gameweeks, optimizer, projection, projections, squad, suggestion]. The branch review found Free Hit permanence and bank-reversion bugs, Wildcard lock loss, probability double-discounting in captain xP, bootstrap policy drift, incorrect purchase-price reconstruction, counterfactual chip comparisons that do not replay the timeline, weak API validation, and redundant persisted transfer/permanent-squad state. Focused chip tests and typecheck pass, but successful suggestion execution and these edge cases are untested.

## Outcome

- Signal: useful

## Source Nodes

- optimizer.ts
- weeklyLineup.ts