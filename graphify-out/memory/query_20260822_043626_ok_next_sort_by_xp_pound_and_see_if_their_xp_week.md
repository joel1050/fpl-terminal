---
type: "query"
date: "2026-08-22T04:36:26.631134+00:00"
question: "ok next sort by xp/pound and see if their xp/week matches with previous seasons pts/week among other other stats like min and xmin"
contributor: "graphify"
outcome: "useful"
source_nodes: ["valuePerMillion()", "projectPlayer()", "expectedMinutes.ts", "HistoricalBundle", "enrichPlayers.ts"]
---

# Q: ok next sort by xp/pound and see if their xp/week matches with previous seasons pts/week among other other stats like min and xmin

## Answer

Expanded from original query via vocab: [value, expected, points, historical, minutes, player, projection, price]. Sorting by the app valueNext5 metric, which is five-gameweek xP divided by price in millions, produces a top 20 made up of 17 defenders and 3 midfielders. Against 2025/26 totalPoints divided by 38, this group has mean projected 3.78 points per week versus 3.09 historical, +0.70 bias, 0.72 mean absolute error, and 0.69 correlation. xMin averages 76.5 versus 69.0 historical minutes per gameweek, +7.5 minutes, with 10.2 minute mean absolute error and 0.80 correlation. The clearest rotation-driven flags are Groß (+2.06 points per week and 82.9 xMin versus 43.1 historical minutes), Maatsen (+1.86 and 66.0 versus 41.8), Wieffer (+1.31 and 67.3 versus 50.0), Gomez (+1.23), Justin (+1.11), and De Cuyper (+1.09). Stable value picks such as Van Hecke, Shaw, Rodon, Senesi, Mitchell, Cash, and F.Kadıoğlu are much closer. The value sort is therefore more optimistic and less well calibrated than raw xP because cheap defenders magnify clean-sheet, appearance, and lineup assumptions.

## Outcome

- Signal: useful

## Source Nodes

- valuePerMillion()
- projectPlayer()
- expectedMinutes.ts
- HistoricalBundle
- enrichPlayers.ts