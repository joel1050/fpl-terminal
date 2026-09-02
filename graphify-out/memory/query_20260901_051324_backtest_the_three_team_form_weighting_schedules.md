---
type: "query"
date: "2026-09-01T05:13:24.422954+00:00"
question: "backtest the three team-form weighting schedules"
contributor: "graphify"
outcome: "useful"
source_nodes: ["calculateFixtureAdjustment()", "fixtureAdjustment.ts", "applyInSeasonForm()"]
---

# Q: backtest the three team-form weighting schedules

## Answer

Expanded from graph vocabulary around team form, clean-sheet probability, fixture adjustment, strengths, and expected goals. Added scripts/backtest/team-form-schedules.ts and ran a leakage-free walk-forward comparison on 660 2025/26 team-fixtures. Current effective/(effective+10): Brier 0.1840, AUC 0.625, logloss 0.5509, goals-against RMSE 1.079. matches/(matches+10): Brier 0.1857, delta +0.0017 with gameweek-clustered 95% CI [-0.0001,+0.0033], AUC 0.614, logloss 0.5555, GA RMSE 1.101. Linear matches/38: Brier 0.1841, delta +0.0001 [-0.0017,+0.0020], AUC 0.621, logloss 0.5521, GA RMSE 1.090. In GW24-38 current also led: 0.1829 versus 0.1847 and 0.1841. Neither higher-form schedule improved accuracy; linear is statistically unresolved and least harmful. Typecheck and focused ESLint pass.

## Outcome

- Signal: useful

## Source Nodes

- calculateFixtureAdjustment()
- fixtureAdjustment.ts
- applyInSeasonForm()