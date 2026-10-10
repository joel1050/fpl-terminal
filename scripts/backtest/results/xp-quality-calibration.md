# xP calibration quality

Input: `output/xp-quality/rows.json` (16,249 common-cohort player-gameweeks from 49,212 source rows; SHA-256 `e9b2a2f534c3347923a2998ce022cd9a652b1cf7ac42c2a63aecae960354cf08`).

Bias is mean predicted xP minus mean actual points, so positive values mean overprediction. The weighted calibration gap is the row-share-weighted absolute bias across fixed integer xP bins. Intervals use a deterministic, season-stratified gameweek-cluster bootstrap with 2,000 replicates, resampling every gameweek in each cohort including weeks with no rows in a given bin; empty replicates are omitted.

## Overall and slices

| Slice | Rows | Mean xP | Mean actual | Signed bias (95% CI) | Weighted calibration gap |
|---|---:|---:|---:|---:|---:|
| All rows | 16,249 | 2.742 | 2.744 | -0.001 [-0.038, 0.035] | 0.054 |
| 2024-25 | 8,141 | 2.772 | 2.629 | 0.143 [0.092, 0.193] | 0.163 |
| 2025-26 | 8,108 | 2.712 | 2.859 | -0.146 [-0.198, -0.095] | 0.180 |
| GK | 1,423 | 3.038 | 2.791 | 0.247 [0.114, 0.383] | 0.266 |
| DEF | 6,039 | 2.538 | 2.465 | 0.073 [-0.007, 0.153] | 0.089 |
| MID | 7,219 | 2.735 | 2.826 | -0.091 [-0.151, -0.032] | 0.116 |
| FWD | 1,568 | 3.294 | 3.393 | -0.099 [-0.247, 0.048] | 0.337 |
| Plausible starters (expectedMinutes ≥60) | 10,015 | 3.267 | 3.225 | 0.042 [-0.016, 0.095] | 0.062 |

## Pooled calibration bins

| Predicted xP | Rows | GWs | Mean xP | Mean actual | Bias (95% CI) | Band status |
|---|---:|---:|---:|---:|---:|---|
| 0–<1 | 667 | 66 | 0.782 | 0.918 | -0.135 [-0.323, 0.031] | ok |
| 1–<2 | 3,208 | 66 | 1.557 | 1.626 | -0.068 [-0.157, 0.015] | ok |
| 2–<3 | 6,277 | 66 | 2.523 | 2.533 | -0.010 [-0.084, 0.060] | ok |
| 3–<4 | 4,583 | 66 | 3.418 | 3.419 | -0.001 [-0.104, 0.103] | ok |
| 4–<5 | 1,044 | 66 | 4.360 | 4.097 | 0.264 [0.075, 0.443] | ok |
| 5–<6 | 229 | 63 | 5.401 | 5.031 | 0.371 [-0.223, 0.991] | ok |
| 6–<7 | 127 | 45 | 6.443 | 6.425 | 0.018 [-0.603, 0.825] | ok |
| 7–<8 | 70 | 35 | 7.453 | 8.200 | -0.747 [-2.239, 1.167] | ok |
| 8–<9 | 28 | 18 | 8.361 | 6.964 | 1.397 — | sparse: fewer than 30 rows |
| 9–<10 | 10 | 9 | 9.412 | 7.200 | 2.212 — | sparse: fewer than 30 rows |
| 10+ | 6 | 5 | 13.128 | 16.167 | -3.039 — | sparse: fewer than 30 rows |

Sparse bands are defined before analysis as fewer than 30 rows or 10 distinct season-gameweek clusters; their interval is withheld. Intervals are also withheld if fewer than 90% of resamples contain at least one row in the band. The plausible-starter slice uses forecast expectedMinutes ≥60 and does not filter on actual minutes.

## Scope and limits

These are reconstructed historical predictions under a fixed £5.0m price prior, with archived injury, lineup, and complete roster inputs unavailable. The evaluated seasons have been used in earlier model work, so these results describe calibration on the available reconstruction and are not a pristine future holdout. They do not establish whether the model beats the rolling-points or minutes-only baselines; that is reported separately.

Reproduce with: `node --import tsx scripts/backtest/xp-quality-calibration.ts output/xp-quality/rows.json`

