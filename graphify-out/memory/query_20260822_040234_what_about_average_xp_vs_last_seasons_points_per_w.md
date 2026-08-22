---
type: "query"
date: "2026-08-22T04:02:34.197546+00:00"
question: "what about average xp vs last seasons points per week"
contributor: "graphify"
outcome: "useful"
source_nodes: ["projectPlayer()", "enrichPlayers.ts", "HistoricalBundle", "projectPlayer.ts"]
---

# Q: what about average xp vs last seasons points per week

## Answer

Expanded from original query via vocab: [expected, points, historical, season, projection, player]. For the same top 20 sorted by next5 xP, compare next5 divided by 5 with 2025/26 totalPoints divided by 38. Mean projected average is 4.77 points per week versus 4.44 historical, a +0.33 bias; mean absolute difference is 0.58 and correlation is 0.774. The model is broadly close but mildly optimistic. Largest positive gaps are Palmer +1.42, Wirtz +1.24, Cherki +0.97, Foden +0.94, Gakpo +0.81, Mbeumo +0.86, and Enzo +0.78; Haaland and Fernandes are slightly below historical, while Gabriel and Semenyo are about 0.6 to 0.7 below. Differences are expected because xP uses upcoming fixtures, team strength, per-90 rates, and selection scenarios while last-season points per week is an actual full-season baseline.

## Outcome

- Signal: useful

## Source Nodes

- projectPlayer()
- enrichPlayers.ts
- HistoricalBundle
- projectPlayer.ts