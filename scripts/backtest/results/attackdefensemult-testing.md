# ClubElo attack and defence multiplier experiment

Recommendation: **inconclusive** — The final intervals do not establish both a relevant team-xG and an integrated player-xP improvement while meeting all non-inferiority limits.

The 2024/25 protocol selected **curve-lambda=0.01** before 2025/26 final scoring. The final comparison uses 28838 matched player-GWs and 760 team-perspective fixture rows; every paired interval uses 5,000 season-GW cluster draws with seed 0xad202610.

## Selected model versus production on 2025/26

- Attacking team xG RMSE: 0.73220 → 0.73302 (Δ +0.00082, 95% [-0.00607, 0.00773]).
- Conceded team xG RMSE: 0.72483 → 0.73088 (Δ +0.00606, 95% [0.00127, 0.01089]).
- Goals-conceded RMSE: 1.09307 → 1.09759 (Δ +0.00452, 95% [-0.00051, 0.00997]).
- Clean-sheet Brier: 0.18048 → 0.18039 (Δ -0.00009, 95% [-0.00076, 0.00064]).
- Integrated player-GW xP RMSE: 1.96369 → 1.96368 (Δ -0.00001, 95% [-0.00094, 0.00099]).
- Integrated player-GW xP MAE: 0.96275 → 0.96372 (Δ +0.00097, 95% [0.00047, 0.00155]); signed bias: -0.12013 → -0.11767 (Δ +0.00246, 95% [0.00197, 0.00294]).
- Goal, assist, and clean-sheet component RMSE deltas: -0.00005, 0.00003, -0.00034 xP.
- Mean component shifts candidate minus production: {"appearance":0,"goals":0.005513900581633409,"assists":0.0032947779582008195,"cleanSheets":-0.005422209057701728,"goalsConceded":-0.002619181096137763,"saves":0.0004697040974501522,"defensiveContribution":0,"bonus":0.001228862212581465,"cards":0,"penalties":0}.

## Coverage and method limits

Fit/selection/final seasons were 2023/24, 2024/25 and 2025/26. The selected-arm final coverage scored 28838 player-GWs, including 17629 explicit zero-minute DNPs and 10 scheduled double-team-GWs; absent player rows were excluded as unknown.

Historical prices, FPL status/chance, archived lineups and forecast-time positions are unavailable in these prepared inputs. All arms therefore share a £5.0m prior, status `a`, no chance-of-playing factor, position from season-level history, and selection reconstructed from adjacent-season evidence plus strictly prior explicit match rows. Historical final schedules stand in for deadline schedules. The seasons were used in earlier model development, so this is reused historical validation, not a pristine holdout. Bootstrap intervals are conditional on fitted parameters and omit parameter-estimation uncertainty.

The generated player pipeline was checked against production for every scored player-GW, with schedule-adjusted form, expected minutes, fixture components and double-GW aggregation unchanged. Production files were not modified.

## Reproduction

```sh
BACKTEST_ATTACK_DEFENSE_DATA_DIR=/tmp/fpl-tier-c-elo-corrected-20261008 node --import tsx scripts/backtest/attackdefensemult-testing.ts freeze
BACKTEST_ATTACK_DEFENSE_DATA_DIR=/tmp/fpl-tier-c-elo-corrected-20261008 node --import tsx scripts/backtest/attackdefensemult-testing.ts run
npx vitest run tests/core/attackdefensemult-testing.test.ts
```

Detailed per-arm metrics, calibration tables, curves, hashes, fitted parameters and player predictions are in [attackdefensemult-testing.json](./attackdefensemult-testing.json) and output/attackdefensemult-testing/. Frozen Git revision: f1900f17e5f5b0993785144837d27631cadf20fe; frozen dirty-tree SHA-256: 59bc721c1539a29eee079701c12965ca85fb090dbb22cf6b6a94caaea52ccc35.
