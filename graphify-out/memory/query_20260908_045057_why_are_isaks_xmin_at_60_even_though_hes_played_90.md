---
type: "query"
date: "2026-09-08T04:50:57.968917+00:00"
question: "why are isaks xmin at 60 even though hes played 90 min 90 min 63 min last few games"
contributor: "graphify"
outcome: "useful"
source_nodes: ["expectedMinutes.ts", "projectPlayer.ts", "HistoricalBundle"]
---

# Q: why are isaks xmin at 60 even though hes played 90 min 90 min 63 min last few games

## Answer

Expanded from original query via vocab: [expected, minutes, selection, start, current, season, historical, player, projection, live]. EXP MIN is probability-weighted, not the recent average. Isak has expectedStartMinutes 75.825, startProbability 0.829, cameoProbability 0.034, and expectedCameoMinutes 16.5, yielding 63.42. The low start probability comes from a 2025/26 seed of 8 starts over 38 historical rows, updated three times by the 0.40 EWMA; the earlier change updated duration but did not replace the conservative start-probability model.

## Outcome

- Signal: useful

## Source Nodes

- expectedMinutes.ts
- projectPlayer.ts
- HistoricalBundle