---
type: "query"
date: "2026-08-22T04:42:12.345810+00:00"
question: "normalize minutes played, and compare the xp bias, +.7 is a lot and may point at some issues"
contributor: "graphify"
outcome: "useful"
source_nodes: ["valuePerMillion()", "projectPlayer()", "expectedMinutes.ts", "HistoricalBundle", "fixtureAdjustment.ts"]
---

# Q: normalize minutes played, and compare the xp bias, +.7 is a lot and may point at some issues

## Answer

Expanded from original query via vocab: [expected, minutes, points, historical, projection, player, value]. For the top 20 XP per pound players, raw projected average is 3.78 points per week versus 3.09 historical, a +0.70 bias. Normalizing historical output to each player's projected xMin using historical points per 90 reduces the bias to +0.33 points per week, with normalized MAE 0.37 and projected versus historical points-per-90 correlation 0.807. About +0.36 of the original gap comes from higher assumed minutes and +0.33 remains as scoring-rate or fixture-model uplift. The largest normalized residuals are Maatsen +1.04, Gomez +0.75, Thiaw +0.69, Shaw +0.68, Virgil +0.57, Kayode +0.53, and Rodon +0.50. Groß falls from +2.06 raw to +0.16 after normalization, so his problem is almost entirely the assumed 43 to 83 minutes per gameweek jump. A rough clean-sheet check contributes only about +0.03 per week after minutes normalization, so clean-sheet probability is not the main cause. The remaining +0.33 is a real but moderate rate or fixture calibration concern, not solely an xMin issue.

## Outcome

- Signal: useful

## Source Nodes

- valuePerMillion()
- projectPlayer()
- expectedMinutes.ts
- HistoricalBundle
- fixtureAdjustment.ts