# xP quality: simple baseline comparison

## Results

Full-row current-model metrics score every eligible production forecast. Baseline comparisons use the identical intersection where both baselines meet their predeclared history gates; negative ΔRMSE favors the current model.

| Season | All xP rows | Common rows | Predictor | RMSE | MAE | Mean bias |
|---|---:|---:|---|---:|---:|---:|
| 2024-25 | 23,575 | 8,141 | Production xP | 2.9079 | 2.1298 | 0.1428 |
| 2024-25 | 23,575 | 8,141 | Previous model (74ceff2) | 2.9621 | 2.1416 | 0.0620 |
| 2024-25 | 23,575 | 8,141 | Rolling prior points/fixture | 3.1522 | 2.2865 | 0.2234 |
| 2024-25 | 23,575 | 8,141 | Prior points/90 × forecast minutes | 3.1026 | 2.1919 | 0.0143 |
| 2024-25 |  | 8,141 | Production − previous model ΔRMSE [95% GW-cluster CI] | -0.0541 [-0.0796, -0.0315] |  |  |
| 2024-25 |  | 8,141 | Production − rolling ΔRMSE [95% GW-cluster CI] | -0.2442 [-0.2785, -0.2085] |  |  |
| 2024-25 |  | 8,141 | Production − P90 ΔRMSE [95% GW-cluster CI] | -0.1946 [-0.2279, -0.1606] |  |  |
| 2025-26 | 25,637 | 8,108 | Production xP | 2.9877 | 2.1581 | -0.1463 |
| 2025-26 | 25,637 | 8,108 | Previous model (74ceff2) | 3.0595 | 2.1977 | -0.2530 |
| 2025-26 | 25,637 | 8,108 | Rolling prior points/fixture | 3.2586 | 2.4604 | 0.3189 |
| 2025-26 | 25,637 | 8,108 | Prior points/90 × forecast minutes | 3.1915 | 2.3383 | 0.0778 |
| 2025-26 |  | 8,108 | Production − previous model ΔRMSE [95% GW-cluster CI] | -0.0718 [-0.0977, -0.0486] |  |  |
| 2025-26 |  | 8,108 | Production − rolling ΔRMSE [95% GW-cluster CI] | -0.2709 [-0.3083, -0.2337] |  |  |
| 2025-26 |  | 8,108 | Production − P90 ΔRMSE [95% GW-cluster CI] | -0.2037 [-0.2324, -0.1727] |  |  |
| Pooled | 49,212 | 16,249 | Production xP | 2.9480 | 2.1439 | -0.0015 |
| Pooled | 49,212 | 16,249 | Previous model (74ceff2) | 3.0111 | 2.1696 | -0.0952 |
| Pooled | 49,212 | 16,249 | Rolling prior points/fixture | 3.2057 | 2.3733 | 0.2711 |
| Pooled | 49,212 | 16,249 | Prior points/90 × forecast minutes | 3.1472 | 2.2650 | 0.0460 |
| Pooled |  | 16,249 | Production − previous model ΔRMSE [95% GW-cluster CI] | -0.0631 [-0.0807, -0.0468] |  |  |
| Pooled |  | 16,249 | Production − rolling ΔRMSE [95% GW-cluster CI] | -0.2577 [-0.2836, -0.2318] |  |  |
| Pooled |  | 16,249 | Production − P90 ΔRMSE [95% GW-cluster CI] | -0.1992 [-0.2215, -0.1765] |  |  |

## Full archived cohort

| Model | Player-GWs | RMSE | MAE |
|---|---:|---:|---:|
| Current production | 49212 | 1.9470 | 0.9660 |
| Previous model | 49212 | 1.9937 | 1.0363 |

The full archive contains many zero-minute outcomes; its lower error is not representative of established starter choices. Use the common cohort above for comparisons against the recent-form baselines.

## Method

The current model is the candidate production `projectPlayer()` path with the 300-point continuous Elo FDR and actual dated ClubElo history. It forecasts one Gameweek, sums every scheduled fixture in a double, and is scored against summed historical FPL points, including explicit zero-minute records.

Both baselines use only the latest five recorded player-GWs before the target. The rolling baseline divides their summed points by their summed player-fixture rows, then multiplies by the target fixture count; this keeps past double gameweeks from changing the per-fixture rate. The minutes baseline divides summed points by summed actual minutes and multiplies by production expected minutes per fixture and the target fixture count. A recorded zero-minute fixture contributes zero points and minutes; absent player-week rows are not treated as zeros. The rolling baseline requires three prior recorded GWs, and the minutes baseline requires 180 prior actual minutes. The paired comparison uses rows where both baselines exist.

The 95% intervals resample whole Gameweeks within each season and keep each season's number of Gameweeks fixed. They describe variation across these observed weeks; they do not make these seasons pristine holdouts, since earlier model work used them during tuning.

## Coverage and limits

- 2024-25: 23,575 production rows, 13,708 explicit zero-minute outcomes, 359 player-GW rows with multiple fixtures, and 8,141 in the common baseline cohort.
- 2025-26: 25,637 production rows, 15,824 explicit zero-minute outcomes, 408 player-GW rows with multiple fixtures, and 8,108 in the common baseline cohort.
- Pooled: 49,212 production rows, 29,532 explicit zero-minute outcomes, 767 player-GW rows with multiple fixtures, and 16,249 in the common baseline cohort.

- Historical availability is reconstructed: every projected player is marked available, with no archived injury status or RotoWire lineup evidence, so forecast minutes are less informed than live production minutes.
- Historical market prices are unavailable; every player receives the common £5.0m price prior.
- The corpus does not contain a complete event-time FPL roster. Rows with no recorded player-fixture outcome are not scored or imputed, and incomplete target fixture rows are excluded by the production backtest harness.
- The 2024/25 and 2025/26 seasons were used in earlier model tuning, so results are historical validation rather than a new untouched holdout.
- The previous model is 74ceff2 rerun using the same actual ClubElo ratings and prepared inputs. Its old clean-sheet helper accepts a club snapshot rather than a ratings map; the temporary runner adapts only that input signature, leaving its production code intact.
