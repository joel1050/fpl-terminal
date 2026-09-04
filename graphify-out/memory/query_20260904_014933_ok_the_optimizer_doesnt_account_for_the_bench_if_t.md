---
type: "query"
date: "2026-09-04T01:49:33.500442+00:00"
question: "ok the optimizer doesnt account for the bench if the horizon is set to gw\\n\\ncan you make the optimizer account for the fact the bench players come on at the rate of P(not start/cameo)"
contributor: "graphify"
outcome: "useful"
source_nodes: ["weeklyLineup.ts", "probabilityDidNotPlay()", "expectedAutosubValue()", "optimizer.ts"]
---

# Q: ok the optimizer doesnt account for the bench if the horizon is set to gw\n\ncan you make the optimizer account for the fact the bench players come on at the rate of P(not start/cameo)

## Answer

Expanded from original query via graph vocab: [optimizer, objective, bench, autosub, weekly, lineup, selection, appearance, probability, points]. Updated the exact MILP to add expected goalkeeper and outfield autosub xP from selected starters' no-appearance probabilities, using the shared weekly-lineup probability helper; Bench Boost remains direct all-15 scoring. Added a focused regression and verified unit, type, lint, build, and browser suites.

## Outcome

- Signal: useful

## Source Nodes

- weeklyLineup.ts
- probabilityDidNotPlay()
- expectedAutosubValue()
- optimizer.ts