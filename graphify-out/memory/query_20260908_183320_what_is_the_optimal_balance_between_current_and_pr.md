---
type: "query"
date: "2026-09-08T18:33:20.788041+00:00"
question: "what is the optimal balance between current and previous season weights as gameweeks progress run some backtests to figure this out you have access to 23/24 seasons onwards"
contributor: "graphify"
outcome: "useful"
source_nodes: ["regressedPlayerRate()", "projectPlayer()", "HistoricalBundle"]
---

# Q: what is the optimal balance between current and previous season weights as gameweeks progress run some backtests to figure this out you have access to 23/24 seasons onwards

## Answer

Expanded from original query via graph vocabulary: [current, historical, player, projection, rate, season, validate, weight]. True adjacent-season backtests on 2023/24->2024/25 and 2024/25->2025/26 show xG/xA form should remain mostly prior-driven. The simplest held-out winner keeps the existing decay 0.95 and 10-match prior but caps current-season share at 20%; 20-25% is effectively tied. This lowers pooled next-10-GW xGI/90 RMSE from 0.12013 to 0.11686 and validation RMSE from 0.11628 to 0.11302. Total-points sensitivity supports faster updating for non-attacking/role signals, so one shared weight is not recommended.

## Outcome

- Signal: useful

## Source Nodes

- regressedPlayerRate()
- projectPlayer()
- HistoricalBundle