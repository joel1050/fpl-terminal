---
type: "query"
date: "2026-08-21T07:38:14.618836+00:00"
question: "what algorithm do you use for optimized lineups, will it always determine the highest xp for gw"
contributor: "graphify"
outcome: "useful"
source_nodes: ["weeklyLineup.ts", "enumerateLegalStartingXIs", "pickWeeklyTeam", "optimizer.ts", "beamConstruct", "objectiveScore"]
---

# Q: what algorithm do you use for optimized lineups, will it always determine the highest xp for gw

## Answer

Expanded via graph vocabulary: weekly, lineup, enumerate, formation, objective, score, projection, optimize, optimizer, starting, bench, captain. The GW TEAM picker exhaustively enumerates every legal XI in a fixed legal 15-player squad, sums fixture xP for the gameweek, limits risk-aware choices to lineups within 0.25 xP of the maximum, evaluates all six bench orders, and selects captaincy afterward. AGGRESSIVE guarantees the highest raw XI xP among the supplied projections; SAFE and BALANCED can give up at most 0.25 xP for lower DNP risk or higher expected minutes. It does not globally optimize XI plus captain plus autosub as one joint objective. The full 15-player squad optimizer is a pruned beam search over candidate pools and is heuristic, not a global maximum guarantee.

## Outcome

- Signal: useful

## Source Nodes

- weeklyLineup.ts
- enumerateLegalStartingXIs
- pickWeeklyTeam
- optimizer.ts
- beamConstruct
- objectiveScore