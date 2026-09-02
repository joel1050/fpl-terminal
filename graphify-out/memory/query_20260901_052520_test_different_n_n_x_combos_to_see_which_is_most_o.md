---
type: "query"
date: "2026-09-01T05:25:20.234091+00:00"
question: "test different n/n+x combos to see which is most optimal, also which seasons are you using for this backtest"
contributor: "graphify"
outcome: "useful"
source_nodes: ["applyInSeasonForm()", "calculateFixtureAdjustment()", "fixtureAdjustment.ts"]
---

# Q: test different n/n+x combos to see which is most optimal, also which seasons are you using for this backtest

## Answer

Expanded from graph vocabulary around team form, clean sheets, probability, strengths, expected goals, and fixture adjustment. Swept integer x from 0 through 500 plus near-prior-only values for n/(n+x), using production-like five-tier priors and leakage-free walk-forward predictions from GW6. Extended data to 2023/24, 2024/25, and 2025/26, 1,982 team-fixtures total. Per-season Brier optima were x=12 at 0.16322 versus current 0.16514, x=72 at 0.17380 versus 0.17496, and x=144 at 0.18146 versus 0.18323. Pooled optimum was x=76 at Brier 0.17397 versus current 0.17443, giving current-form shares of 23.2 percent entering GW24 and 33.3 percent after 38 matches. The gain is only 0.00046 and not stable: leave-one-season-out tuning lost to current in 2023/24 and 2025/26 and barely won in 2024/25. Therefore x=76 is the numerical pooled answer, but the existing effective/(effective+10) schedule is more robust; do not implement x=76 from this evidence alone. scripts/backtest/team-form-schedules.ts contains the reproducible sweep; ESLint and typecheck pass.

## Outcome

- Signal: useful

## Source Nodes

- applyInSeasonForm()
- calculateFixtureAdjustment()
- fixtureAdjustment.ts