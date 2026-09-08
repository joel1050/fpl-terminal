---
type: "query"
date: "2026-09-08T05:07:34.528374+00:00"
question: "yep override previous season minutes if there is a decent amount of minutes played this season"
contributor: "graphify"
outcome: "useful"
source_nodes: ["expectedMinutes.ts", "projectPlayer.ts", "HistoricalBundle"]
---

# Q: yep override previous season minutes if there is a decent amount of minutes played this season

## Answer

Expanded from original query via vocab: [expected, minutes, selection, current, season, historical, player, rate]. Added a 240-observed-minute role threshold in selection.ts. At or above it, current-season start/cameo frequencies and average minutes per start replace the previous-season role; below it, the historical EWMA remains. Isak now has an 81-minute start duration and 75.552 probability-weighted expected minutes after the current RotoWire predicted-XI discount. Full unit suite, typecheck, changed-file lint, and production build pass.

## Outcome

- Signal: useful

## Source Nodes

- expectedMinutes.ts
- projectPlayer.ts
- HistoricalBundle