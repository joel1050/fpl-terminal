# Ranking quality of current production xP

## Result

The evaluation matched **16,249 of 49,212 current-production rows** to both baselines across 66 season/gameweek clusters. The current-production rank correlations and top-k returns below use those same rows, so the model and simple baselines are compared on the same player pool.

A higher Spearman value means the model orders players closer to their realized points within a gameweek. The top-k rows answer a narrower question: how many points the selected high-xP candidates actually returned, on average, over this sample.

## Overall and per-season metrics

### All players: pooled

Matched rows: 16,249 across 66 gameweeks.

| Arm | Equal-GW mean Spearman | Defined GWs | Skipped undefined |
|---|---:|---:|---:|
| Current production xP | 0.362 | 66 | 0 |
| Prior points per fixture | 0.251 | 66 | 0 |
| Prior points per 90 × expected minutes | 0.296 | 66 | 0 |

| Paired Spearman difference | Δρ [95% CI] | Matched GWs |
|---|---:|---:|
| Production − rolling | +0.111 [+0.093, +0.128] | 66 |
| Production − P90 | +0.065 [+0.052, +0.079] | 66 |

Positive Δρ favors production xP; intervals crossing zero don't resolve a difference.

### All players: 2024-25

Matched rows: 8,141 across 33 gameweeks.

| Arm | Equal-GW mean Spearman | Defined GWs | Skipped undefined |
|---|---:|---:|---:|
| Current production xP | 0.372 | 33 | 0 |
| Prior points per fixture | 0.283 | 33 | 0 |
| Prior points per 90 × expected minutes | 0.315 | 33 | 0 |

| Paired Spearman difference | Δρ [95% CI] | Matched GWs |
|---|---:|---:|
| Production − rolling | +0.089 [+0.066, +0.111] | 33 |
| Production − P90 | +0.057 [+0.039, +0.075] | 33 |

Positive Δρ favors production xP; intervals crossing zero don't resolve a difference.

### All players: 2025-26

Matched rows: 8,108 across 33 gameweeks.

| Arm | Equal-GW mean Spearman | Defined GWs | Skipped undefined |
|---|---:|---:|---:|
| Current production xP | 0.352 | 33 | 0 |
| Prior points per fixture | 0.219 | 33 | 0 |
| Prior points per 90 × expected minutes | 0.277 | 33 | 0 |

| Paired Spearman difference | Δρ [95% CI] | Matched GWs |
|---|---:|---:|
| Production − rolling | +0.133 [+0.105, +0.160] | 33 |
| Production − P90 | +0.074 [+0.053, +0.095] | 33 |

Positive Δρ favors production xP; intervals crossing zero don't resolve a difference.

### Plausible starters (>=60 expected minutes per fixture): pooled

Matched rows: 10,015 across 66 gameweeks.

| Arm | Equal-GW mean Spearman | Defined GWs | Skipped undefined |
|---|---:|---:|---:|
| Current production xP | 0.231 | 66 | 0 |
| Prior points per fixture | 0.163 | 66 | 0 |
| Prior points per 90 × expected minutes | 0.160 | 66 | 0 |

| Paired Spearman difference | Δρ [95% CI] | Matched GWs |
|---|---:|---:|
| Production − rolling | +0.068 [+0.044, +0.092] | 66 |
| Production − P90 | +0.071 [+0.046, +0.096] | 66 |

Positive Δρ favors production xP; intervals crossing zero don't resolve a difference.

### Plausible starters (>=60 expected minutes per fixture): 2024-25

Matched rows: 5,008 across 33 gameweeks.

| Arm | Equal-GW mean Spearman | Defined GWs | Skipped undefined |
|---|---:|---:|---:|
| Current production xP | 0.270 | 33 | 0 |
| Prior points per fixture | 0.211 | 33 | 0 |
| Prior points per 90 × expected minutes | 0.206 | 33 | 0 |

| Paired Spearman difference | Δρ [95% CI] | Matched GWs |
|---|---:|---:|
| Production − rolling | +0.059 [+0.029, +0.088] | 33 |
| Production − P90 | +0.064 [+0.035, +0.093] | 33 |

Positive Δρ favors production xP; intervals crossing zero don't resolve a difference.

### Plausible starters (>=60 expected minutes per fixture): 2025-26

Matched rows: 5,007 across 33 gameweeks.

| Arm | Equal-GW mean Spearman | Defined GWs | Skipped undefined |
|---|---:|---:|---:|
| Current production xP | 0.192 | 33 | 0 |
| Prior points per fixture | 0.115 | 33 | 0 |
| Prior points per 90 × expected minutes | 0.114 | 33 | 0 |

| Paired Spearman difference | Δρ [95% CI] | Matched GWs |
|---|---:|---:|
| Production − rolling | +0.077 [+0.039, +0.115] | 33 |
| Production − P90 | +0.078 [+0.038, +0.118] | 33 |

Positive Δρ favors production xP; intervals crossing zero don't resolve a difference.

### Captain candidate ranking (plausible outfield starters): pooled

Matched rows: 8,853 across 66 gameweeks.

| Arm | Equal-GW mean Spearman | Defined GWs | Skipped undefined |
|---|---:|---:|---:|
| Current production xP | 0.239 | 66 | 0 |
| Prior points per fixture | 0.170 | 66 | 0 |
| Prior points per 90 × expected minutes | 0.165 | 66 | 0 |

| Paired Spearman difference | Δρ [95% CI] | Matched GWs |
|---|---:|---:|
| Production − rolling | +0.069 [+0.046, +0.093] | 66 |
| Production − P90 | +0.073 [+0.049, +0.097] | 66 |

Positive Δρ favors production xP; intervals crossing zero don't resolve a difference.

| Outfield plausible starters | Production xP mean actual pts | Rolling mean actual pts | P90 mean actual pts | Production − rolling [95% CI] | Production − P90 [95% CI] |
|---|---:|---:|---:|---:|---:|
| Top 1 | 7.70 | 6.50 | 6.48 | +1.20 [+0.00, +2.44] | +1.21 [+0.17, +2.27] |
| Top 5 | 5.98 | 4.92 | 5.14 | +1.06 [+0.61, +1.52] | +0.84 [+0.37, +1.32] |
| Top 10 | 5.23 | 4.59 | 4.72 | +0.63 [+0.30, +0.97] | +0.51 [+0.22, +0.81] |

Positive return deltas favor the production xP ranking; each arm selects from the identical eligible gameweek pool.

### Captain candidate ranking: 2024-25

Matched rows: 4,439 across 33 gameweeks.

| Arm | Equal-GW mean Spearman | Defined GWs | Skipped undefined |
|---|---:|---:|---:|
| Current production xP | 0.279 | 33 | 0 |
| Prior points per fixture | 0.222 | 33 | 0 |
| Prior points per 90 × expected minutes | 0.215 | 33 | 0 |

| Paired Spearman difference | Δρ [95% CI] | Matched GWs |
|---|---:|---:|
| Production − rolling | +0.057 [+0.025, +0.088] | 33 |
| Production − P90 | +0.064 [+0.034, +0.094] | 33 |

Positive Δρ favors production xP; intervals crossing zero don't resolve a difference.

| Outfield plausible starters | Production xP mean actual pts | Rolling mean actual pts | P90 mean actual pts | Production − rolling [95% CI] | Production − P90 [95% CI] |
|---|---:|---:|---:|---:|---:|
| Top 1 | 8.82 | 8.15 | 8.33 | +0.67 [-0.97, +2.42] | +0.48 [-0.82, +1.85] |
| Top 5 | 6.56 | 5.57 | 5.82 | +0.99 [+0.40, +1.61] | +0.73 [+0.04, +1.41] |
| Top 10 | 5.67 | 4.94 | 5.13 | +0.74 [+0.28, +1.21] | +0.55 [+0.15, +0.97] |

Positive return deltas favor the production xP ranking; each arm selects from the identical eligible gameweek pool.

### Captain candidate ranking: 2025-26

Matched rows: 4,414 across 33 gameweeks.

| Arm | Equal-GW mean Spearman | Defined GWs | Skipped undefined |
|---|---:|---:|---:|
| Current production xP | 0.198 | 33 | 0 |
| Prior points per fixture | 0.117 | 33 | 0 |
| Prior points per 90 × expected minutes | 0.116 | 33 | 0 |

| Paired Spearman difference | Δρ [95% CI] | Matched GWs |
|---|---:|---:|
| Production − rolling | +0.081 [+0.045, +0.118] | 33 |
| Production − P90 | +0.083 [+0.045, +0.120] | 33 |

Positive Δρ favors production xP; intervals crossing zero don't resolve a difference.

| Outfield plausible starters | Production xP mean actual pts | Rolling mean actual pts | P90 mean actual pts | Production − rolling [95% CI] | Production − P90 [95% CI] |
|---|---:|---:|---:|---:|---:|
| Top 1 | 6.58 | 4.85 | 4.64 | +1.73 [+0.09, +3.45] | +1.94 [+0.30, +3.64] |
| Top 5 | 5.41 | 4.27 | 4.46 | +1.13 [+0.44, +1.82] | +0.95 [+0.27, +1.61] |
| Top 10 | 4.78 | 4.25 | 4.31 | +0.53 [+0.06, +0.97] | +0.48 [+0.03, +0.88] |

Positive return deltas favor the production xP ranking; each arm selects from the identical eligible gameweek pool.

## Method and limits

The input is `output/xp-quality/rows.json`. For each season/gameweek and player cohort, the script calculates Spearman correlation between predicted one-gameweek xP and actual points, using average ranks for ties. It reports an equal-gameweek mean, so rounds with larger player pools do not dominate. Constant prediction or outcome ranks make rho undefined; those gameweeks are counted and skipped.

The three arms are current `projectPlayer()` xP, prior points divided by prior recorded fixture rows over the latest five recorded player-gameweeks and scaled by the target fixture count, and prior points per 90 over the same five gameweeks multiplied by the model's expected minutes summed over scheduled fixtures. Baselines require at least three prior recorded gameweeks and 180 actual minutes. DNP fixture rows count as zero points; wholly missing player-gameweeks are not imputed. Starter membership uses the current projection's per-fixture expected minutes, with a threshold of 60, so double gameweeks are not accidentally treated as one 120-minute fixture.

Top-1, top-5 and top-10 use the predicted order within each game's plausible DEF/MID/FWD candidate pool, with lower player ID breaking exact xP ties. These returns are not legal XI or captain simulations because the archive lacks full event-time roster membership and squad constraints.

Intervals are paired, season-stratified gameweek-cluster bootstraps with 10,000 resamples. The same gameweeks are drawn for both arms, and each season keeps its matched gameweek count. Positive production-minus-baseline deltas favor production xP.

The data reconstructs selection with fallback expected minutes and a fixed £5.0m price prior, and does not include complete event-time availability or predicted-lineup inputs. The seasons 2024/25 and 2025/26 have already informed prior model choices, so this is a useful matched historical check, not a fresh independent holdout.

## Reproduction

```sh
node --import tsx scripts/backtest/xp-quality-ranking.ts output/xp-quality/rows.json
npx vitest run tests/core/xp-quality-ranking.test.ts
```
