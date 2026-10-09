# Tier C: Elo FDR divisor

## Result

The calibration season selected a 300-point divisor by team-xG RMSE. On the two held-out seasons, GAP(300) reduced pooled team-xG RMSE by `0.00307` versus the former production GAP(150), with a paired gameweek-cluster 95% interval of `[-0.00514, -0.00107]`. It improved directionally in both seasons and significantly in 2025/26; the 2024/25 interval crosses zero. The pooled xP interval also favors GAP(300), though only narrowly.

I changed the production divisor from 150 to 300 in `lib/clubElo.ts` and updated the focused formula tests. The no-base arm had the best xP RMSE, but its pooled team-xG interval crosses zero, so it did not meet the primary team-xG criterion. The xP score uses realized minutes and only rows with minutes above zero, so it does not measure the start or availability model.

## Method

- Arms were GAP(150), GAP(200), GAP(300), and NONE. The first three use `clamp(3 + (opponentElo - ownElo) / divisor, 1, 5)` as continuous `exactDifficulty`; the integer-rounded `difficulty` is used only for display and fallback. NONE sets difficulty to 3, leaving venue and team-strength adjustments intact.
- GW6–38 of 2023/24 selected the arm with the lowest team-xG RMSE. GW6–38 of 2024/25 and 2025/26 were untouched evaluation seasons. 2022/23 was excluded because the Elo ratings start flat; 2023/24 was calibration only, never evaluation.
- Elo was generated from match results with K=20 and then rescaled to the current ClubElo mean and spread. These are historical Elo proxies, not archived ClubElo ratings, so the result tests the divisor on a shared proxy and cannot establish that ClubElo itself is the best rating source.
- Every prediction uses the Elo snapshot from the start of its Gameweek, before any match in that week, to avoid leaking earlier same-week results. The team-xG target is each team's realized xG divided by that season's league mean. The xP target is player points per fixture, with actual minutes supplied to isolate scoring from minutes prediction.
- Intervals are paired percentile bootstraps with gameweek clusters, 10,000 draws, seed `0xe10fd`. The pooled interval resamples 66 season/Gameweek clusters.

## Samples

| Set | Team fixtures | Played player-fixtures | Gameweeks |
|---|---:|---:|---:|
| 2023/24 calibration | 662 | 9,905 | 33 |
| 2024/25 holdout | 660 | 10,030 | 33 |
| 2025/26 holdout | 660 | 9,972 | 33 |
| Pooled holdout | 1,320 | 20,002 | 66 |

## Team xG results

RMSE is against the realized team xG multiplier. Delta and confidence intervals are paired against GAP(150); negative values favor that arm.

| Set | GAP(150) | GAP(200) | GAP(300) | NONE |
|---|---:|---:|---:|---:|
| 2023/24 calibration | 0.51442 | 0.51327; −0.00115 [−0.00257, 0.00028] | 0.51306; −0.00136 [−0.00452, 0.00166] | 0.51648; +0.00206 [−0.00578, 0.00951] |
| 2024/25 holdout | 0.53908 | 0.53789; −0.00120 [−0.00240, −0.00003] | 0.53728; −0.00180 [−0.00443, 0.00074] | 0.54133; +0.00224 [−0.00422, 0.00847] |
| 2025/26 holdout | 0.53291 | 0.53050; −0.00241 [−0.00381, −0.00104] | 0.52855; −0.00436 [−0.00732, −0.00136] | 0.52816; −0.00475 [−0.01217, 0.00225] |
| Pooled holdout | 0.53601 | 0.53421; −0.00180 [−0.00277, −0.00092] | **0.53293; −0.00307 [−0.00514, −0.00107]** | 0.53478; −0.00122 [−0.00617, 0.00358] |

## Player xP results

The backtest's production parity gate passed exactly in all four seasons: 9,872, 9,905, 10,030, and 9,972 rows respectively, with worst total and component gaps of zero. Each FDR arm also passed adjustment-level parity against `calculateFixtureAdjustment()` for both the continuous `exactDifficulty` path and the integer fallback: 5,296 checks in 2023/24 and 5,280 in each holdout season.

| Set | GAP(150) | GAP(200) | GAP(300) | NONE |
|---|---:|---:|---:|---:|
| 2023/24 calibration | 2.73657 | 2.73640; −0.00017 [−0.00111, 0.00069] | 2.73647; −0.00010 [−0.00219, 0.00187] | 2.73761; +0.00104 [−0.00391, 0.00572] |
| 2024/25 holdout | 2.60934 | 2.60887; −0.00047 [−0.00145, 0.00047] | 2.60784; −0.00150 [−0.00343, 0.00041] | 2.60437; −0.00497 [−0.00951, −0.00058] |
| 2025/26 holdout | 2.69925 | 2.69869; −0.00056 [−0.00138, 0.00021] | 2.69807; −0.00118 [−0.00298, 0.00049] | 2.69762; −0.00163 [−0.00568, 0.00218] |
| Pooled holdout | 2.65454 | 2.65403; −0.00051 [−0.00114, 0.00009] | **2.65321; −0.00133 [−0.00269, −0.00002]** | 2.65127; −0.00327 [−0.00624, −0.00032] |

## Reproduction

The prepared source directory was copied before generating week-start ratings; the shared preparation directory was not changed.

```sh
test ! -e /tmp/fpl-tier-c-elo-corrected-20261008 && cp -a /tmp/fpl-tier-c-seasons-20261008 /tmp/fpl-tier-c-elo-corrected-20261008
npx tsx scripts/backtest/elo-history.ts /tmp/fpl-tier-c-elo-corrected-20261008 > output/tier-c/elo-history-week-start-20261008.log 2>&1
BACKTEST_MULTI_DATA_DIR=/tmp/fpl-tier-c-elo-corrected-20261008 npx tsx scripts/backtest/elo-fdr.ts > output/tier-c/elo-fdr-20261008.log 2>&1
```

Run the parity gate separately before using the xP columns:

```sh
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-elo-corrected-20261008/2022-23 npx tsx scripts/backtest/validate.ts > output/tier-c/validate-2022-23-20261008.log 2>&1
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-elo-corrected-20261008/2023-24 npx tsx scripts/backtest/validate.ts > output/tier-c/validate-2023-24-20261008.log 2>&1
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-elo-corrected-20261008/2024-25 npx tsx scripts/backtest/validate.ts > output/tier-c/validate-2024-25-20261008.log 2>&1
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-elo-corrected-20261008/2025-26 npx tsx scripts/backtest/validate.ts > output/tier-c/validate-2025-26-20261008.log 2>&1
npx vitest run tests/data/club-elo.test.ts > output/tier-c/club-elo-test-20261008.log 2>&1
npx tsc --noEmit --pretty false > output/tier-c/typecheck-20261008.log 2>&1
```

The focused production test passed (11 tests), and TypeScript passed. Command output is in `output/tier-c/`.
