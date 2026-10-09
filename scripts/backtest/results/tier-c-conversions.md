# Tier C: conversion factors

**Decision: leave production constants unchanged.** The pooled fit has no resolved gain in either held-out season or pooled, and neutral factors are also unresolved.

## Baseline and method

HEAD was `74ceff274962102b5d774043b29783b22be13d75`. The shipped factors at this HEAD are:

| Position | Goal | Assist |
|---|---:|---:|
| GK | 1.000 | 1.000 |
| DEF | 0.700 | 1.272 |
| MID | 0.981 | 1.207 |
| FWD | 0.988 | 2.114 |

`validate.ts` passed before scoring each season; the harness matched `projectPlayer()` with zero component gap on 9,872 rows (2022/23), 9,905 (2023/24), 10,030 (2024/25), and 9,972 (2025/26). The xP sample uses the parity-covered GWs 6–38 and actual minutes, with all other projection components held fixed.

The fitted arm uses a through-origin least-squares slope from observed match xG/xA to actual goals/assists, pooled across earlier seasons. It fits 2023/24 and tests 2024/25, then pools 2023/24–2024/25 and tests 2025/26. This keeps fixture ratings out of conversion fitting; the held-out xP still uses the shipped projection and fixture model. The neutral arm uses 1.0 for every factor. GK factors stay at 1.0 because training data has no goalkeeper goals and only 2 then 12 goalkeeper assists. The 2022/23 season is excluded from both fit and evaluation because its xG starts at GW16.

## Held-out whole-model xP

Each delta is candidate RMSE minus shipped RMSE. Confidence intervals use 4,000 paired bootstrap resamples of gameweek clusters, stratified by held-out season.

| Held-out season | Rows / clusters | Shipped RMSE | Neutral RMSE, Δ [95% CI] | Pooled fit RMSE, Δ [95% CI] |
|---|---:|---:|---:|---:|
| 2024/25 | 10,030 / 33 | 2.6011 | 2.6016, +0.0004 [-0.0016, +0.0025] | 2.6012, +0.0001 [-0.0017, +0.0020] |
| 2025/26 | 9,972 / 33 | 2.6950 | 2.6937, -0.0014 [-0.0036, +0.0009] | 2.6953, +0.0002 [-0.0015, +0.0020] |
| Pooled walk-forward | 20,002 / 66 | 2.6484 | 2.6479, -0.0005 [-0.0020, +0.0010] | 2.6485, +0.0002 [-0.0011, +0.0015] |

The fit learned different factors as training seasons accumulated:

| Evaluation | Training seasons | Goals DEF / MID / FWD | Assists DEF / MID / FWD |
|---|---|---|---|
| 2024/25 | 2023/24 | 0.901 / 1.029 / 0.941 | 1.065 / 1.103 / 1.248 |
| 2025/26 | 2023/24 + 2024/25 | 0.859 / 0.999 / 0.942 | 0.989 / 1.091 / 1.262 |

## Limits

The pooled metric is a walk-forward combination: 2024/25 uses factors fit on 2023/24, while 2025/26 uses the two-season fit. The 2023/24 and 2024/25 raw xG/xA rows used for fitting do not depend on Elo, so the 2023/24 Elo burn-in does not enter that fit; held-out xP seasons are 2024/25 and 2025/26, after Elo burn-in. No 2022/23 match rows enter fitting or scoring. Actual minutes make this a scoring-factor comparison, not a test of the minutes model. Rare events, especially goalkeeper assists, do not support precise factors.

## Rerun

Run from the worktree root with the prepared data still read-only at /tmp/fpl-tier-c-seasons-20261008:

```bash
set -e
mkdir -p output/tier-c
for season in 2022-23 2023-24 2024-25 2025-26; do
  BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/$season node_modules/.bin/tsx scripts/backtest/validate.ts > output/tier-c/parity-$season.log 2>&1
done
for season in 2023-24 2024-25 2025-26; do
  BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/$season node_modules/.bin/tsx scripts/backtest/tier-c-conversions.ts collect > output/tier-c/$season.rows.json 2> output/tier-c/collect-$season.log
done
node_modules/.bin/tsx scripts/backtest/tier-c-conversions.ts score output/tier-c/2023-24.rows.json output/tier-c/2024-25.rows.json output/tier-c/2025-26.rows.json > output/tier-c/conversions.log 2>&1
```

The experiment exports the harness's existing conversion maps from scripts/backtest/xp.ts; this keeps the reported shipped baseline tied to the parity-tested harness. Logs and collected rows are under output/tier-c/. No production code changed.
