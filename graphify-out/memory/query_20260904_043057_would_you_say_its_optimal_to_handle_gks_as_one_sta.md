---
type: "query"
date: "2026-09-04T04:30:57.798667+00:00"
question: "would you say its optimal to handle gks as one starting gk and one 4mill bench gk that will stay on the bench or handle gks how the solver handles it"
contributor: "graphify"
outcome: "useful"
source_nodes: ["optimizer.ts", "weeklyLineup.ts", "expectedAutosubValue"]
---

# Q: would you say its optimal to handle gks as one starting gk and one 4mill bench gk that will stay on the bench or handle gks how the solver handles it

## Answer

Expanded from original query via graph vocab: [optimizer, bench, starter, weekly, lineup, price, value, points, squad]. The optimal treatment is a hybrid: do not hard-force a 4.0 goalkeeper, but do not give the reserve goalkeeper the same generic 15-35 percent bench weight as outfield substitutes. Score the chosen starting goalkeeper fully each week and give the reserve goalkeeper only expected autosub value from the starting goalkeeper's DNP probability, or zero as a cheap approximation outside Bench Boost. This lets the exact optimizer select 4.0 plus a set-and-forget starter when extra goalkeeper spend loses to outfield spend, while still permitting a rotating pair when its multiweek starting xP gain pays for the added cost. For a one-GW horizon, the 4.0 reserve will usually be optimal unless Bench Boost is active.

## Outcome

- Signal: useful

## Source Nodes

- optimizer.ts
- weeklyLineup.ts
- expectedAutosubValue