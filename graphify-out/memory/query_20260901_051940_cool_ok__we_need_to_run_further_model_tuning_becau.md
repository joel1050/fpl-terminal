---
type: "query"
date: "2026-09-01T05:19:40.412482+00:00"
question: "cool ok, we need to run further model tuning because of this, can you break down every single calculation that could need tuning in xp calculations"
contributor: "graphify"
outcome: "useful"
source_nodes: ["projectPlayer()", "regressedPlayerRate()", "calculateFixtureAdjustment()", "buildPlayerSelections()", "blendInSeasonForm()"]
---

# Q: cool ok, we need to run further model tuning because of this, can you break down every single calculation that could need tuning in xp calculations

## Answer

Expanded from original query via graph vocab: [project, player, projection, projected, fixture, expected, minutes, selection, probability, regress, regressed, regression, rate, components, points, clean, sheet]. The full xP tuning surface has four upstream layers. Selection and minutes: historical start denominator, current-role evidence, historical/fallback/RotoWire blend weights, predicted and confirmed lineup probabilities, injury gates and floors, start/cameo duration priors, and the missing probability distribution around 60 minutes. Team and fixture: preseason tier mapping, normalization, team xG attack/defence transforms, team-form decay and previous-season weight, its 50 percent ceiling, xG floors, venue handling, FDR multipliers, explicit strength ratio and both clamps, clean-sheet tier anchors/table, fallback lambda, and expected-goals-against inversion. Player rates: position and unknown-player priors, true previous/current-season weights, player-form decay, equal per-appearance weighting despite unequal minutes, 900-minute regression, non-xGI current weight capped at 60 percent, rate ceilings, and goal/assist fallback when xG/xA is absent. Scoring conversion: position goal and assist conversion factors, clean-sheet probability, Poisson goals-conceded deductions, goalkeeper save environment and distribution, defensive-contribution rate/threshold/dispersion, bonus fixture scaling, yellow/red rates and hazard, and missing penalties, penalty saves and own goals. Scenario aggregation also assumes one start duration, one cameo duration, identical per-90 output in starts and cameos, and the same next-match selection probability over the full horizon. Current FPL point values, 60-minute rules, thresholds, double/blank summation and arithmetic should not be fitted. Risk, confidence, nailed rating and value do not affect xP. Tune each latent target directly before total-points RMSE, use walk-forward or leave-one-season-out validation, rebuild season-specific priors without hindsight, and account for rule changes; RotoWire and defensive contributions cannot be robustly multi-season tuned from this archive.

## Outcome

- Signal: useful

## Source Nodes

- projectPlayer()
- regressedPlayerRate()
- calculateFixtureAdjustment()
- buildPlayerSelections()
- blendInSeasonForm()