---
type: "query"
date: "2026-08-24T16:54:25.896536+00:00"
question: "@calculations.md do section 4 now\nsummarize it in a simple manner and rate 1-10 on how accurate you think it is as an estimate, and propose changes that you think would make it more accurate"
contributor: "graphify"
outcome: "useful"
source_nodes: ["buildPlayerSelections()", "projectPlayer()", "HistoricalBundle", "rotowireMapping.ts"]
---

# Q: @calculations.md do section 4 now
summarize it in a simple manner and rate 1-10 on how accurate you think it is as an estimate, and propose changes that you think would make it more accurate

## Answer

Expanded from original query via graph vocab: [selection, availability, probability, historical, rotowire, status, lineup, minutes, confidence].

Section 4 assigns each player probabilities of starting, appearing from the bench, or not playing. It starts from last season's role, adds a rough current-minutes fallback, lets RotoWire dominate when the team is covered, applies injury/suspension information, then converts the scenarios to expected minutes and a 1-5 nailed rating.

Rating: 5/10 overall. It is directionally useful and internally coherent, but the exact probabilities are not calibrated. A fresh RotoWire prediction is reasonably useful for the next fixture; accuracy drops badly over three to five gameweeks because one player-level selection is reused for every future fixture. The model also multiplies correlated RotoWire, FPL doubtful status, and FPL chance signals, which can turn a predicted starter with a stated 75% chance into roughly a 32% start estimate. Current-season starts already exist in the FPL bootstrap but are ignored, fixed 75/25 weights keep last season's role dominant, historical start rows are inferred by sorting minutes rather than preserving the source start flag, and start duration is clamped to at least 60 minutes.

Changes in priority order: make selection fixture/gameweek-specific and decay next-fixture signals toward the role prior; use source precedence rather than multiplying correlated injury signals; blend actual current-season starts and recent minutes with the historical prior using sample-size weighting; preserve per-match start flags and model the probability of reaching 60 minutes; then backtest start/cameo/no-show probabilities with Brier score or log loss and derive confidence from freshness, sample size, and source agreement.

## Outcome

- Signal: useful

## Source Nodes

- buildPlayerSelections()
- projectPlayer()
- HistoricalBundle
- rotowireMapping.ts