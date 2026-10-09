# Tier C backtest reruns

## Result

The production xP harness passed exact parity on all four prepared season corpora. The reruns produced no new, defensible production change from this batch. `schedule-adjust.ts` supports the production schedule-normalization path already in `projectPlayer.ts`; the other scripts either found no resolved gain or no longer test the current production arms.

The shared dataset at `/tmp/fpl-tier-c-seasons-20261008` was read only. Raw command output is in `output/tier-c/` in the experiment worktree.

## Commands

Each command ran in a fresh process because `season.ts` reads `BACKTEST_DATA_DIR` at import. The same command output was captured with `tee` in the named log:

```bash
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2022-23 npx tsx scripts/backtest/validate.ts
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2023-24 npx tsx scripts/backtest/validate.ts
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2024-25 npx tsx scripts/backtest/validate.ts
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2025-26 npx tsx scripts/backtest/validate.ts

BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2022-23 npx tsx scripts/backtest/schedule-adjust.ts 2022-23
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2023-24 npx tsx scripts/backtest/schedule-adjust.ts 2023-24
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2024-25 npx tsx scripts/backtest/schedule-adjust.ts 2024-25
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2025-26 npx tsx scripts/backtest/schedule-adjust.ts 2025-26

BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2022-23 npx tsx scripts/backtest/cleansheets.ts
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2023-24 npx tsx scripts/backtest/cleansheets.ts
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2024-25 npx tsx scripts/backtest/cleansheets.ts
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2025-26 npx tsx scripts/backtest/cleansheets.ts

BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2022-23 npx tsx scripts/backtest/sweep.ts
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2023-24 npx tsx scripts/backtest/sweep.ts
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2024-25 npx tsx scripts/backtest/sweep.ts
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2025-26 npx tsx scripts/backtest/sweep.ts

BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2022-23 npx tsx scripts/backtest/elo-fdr.ts 2022-23
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2023-24 npx tsx scripts/backtest/elo-fdr.ts 2023-24
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2024-25 npx tsx scripts/backtest/elo-fdr.ts 2024-25
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2025-26 npx tsx scripts/backtest/elo-fdr.ts 2025-26

BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2023-24 npx tsx scripts/backtest/anchor.ts
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2024-25 npx tsx scripts/backtest/anchor.ts
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2025-26 npx tsx scripts/backtest/anchor.ts
```

`output/tier-c/` contains `validate-<season>.log`, `schedule-adjust-<season>.log`, `cleansheets-<season>.log`, `sweep-<season>.log`, `elo-fdr-<season>.log`, and `anchor-<season>.log` for every run above. `schedule-adjust.ts` itself drops 14 gameweeks with no xG in 2022/23, leaving only GW16–27 for its anchor and 28–38 for scoring; keep that as a reduced replication, not evidence for a constant. `anchor.ts` was omitted for 2022/23 because its first-half anchor would include fabricated zero-xG weeks. Elo and clean-sheet results for 2022/23 are also retained only as reduced diagnostics. Elo's own README excludes 2022/23 and 2023/24 from evaluation because those are burn-in seasons.

## Results

### Baseline parity

| Season | Played rows | Worst total gap | Worst component gap | Result |
|---|---:|---:|---:|---|
| 2022/23 | 9,872 | 0 | 0 | Pass |
| 2023/24 | 9,905 | 0 | 0 | Pass |
| 2024/25 | 10,030 | 0 | 0 | Pass |
| 2025/26 | 9,972 | 0 | 0 | Pass |

The gate compares `expectedPoints()` against `projectPlayer()` to `1e-9` on each played row. It validates the ordinary form path: `formBefore()` has no opponent or venue metadata, so this gate does not exercise the schedule-adjusted path. That path is measured separately by `schedule-adjust.ts` and covered by `tests/core/schedule-adjusted-form.test.ts`.

### Schedule-adjusted player form

The production-feasible D arm lowered remaining-season xGI/90 RMSE against the unadjusted A arm in every season. The intervals are bootstraps clustered by player, so repeated cutoffs for one player stay together; the script uses actual minutes and requires at least 270 future minutes.

| Season | Player-cutoff rows | A RMSE | D RMSE | D − A, 95% CI |
|---|---:|---:|---:|---:|
| 2023/24 | 1,065 | 0.16457 | 0.14999 | −0.01458 [−0.02292, −0.00672] |
| 2024/25 | 1,118 | 0.18217 | 0.15813 | −0.02403 [−0.03856, −0.01058] |
| 2025/26 | 1,154 | 0.17759 | 0.15962 | −0.01798 [−0.03080, −0.00665] |
| 2022/23 (reduced) | 191 | 0.17595 | 0.15496 | −0.02099 [−0.03815, −0.00503] |

On next-match xGI/90 for started rows, production-feasible E also had lower RMSE than A in each season: 0.20346 vs 0.20817 on 4,183 rows, 0.18384 vs 0.18972 on 4,280 rows, and 0.18966 vs 0.19350 on 4,363 rows. The script reports no interval for these E deltas, and it does not score xP. Its FPL difficulty is also only a proxy for the ClubElo difficulty used by current production. The algorithm is already shipped in `projectPlayer.ts`; this rerun supports keeping it but does not justify a further change.

### Clean-sheet table rerun

There were 660 team-fixtures per season except 662 in 2023/24. The table below compares the hardcoded 5×5 tier-table baseline to one Poisson candidate. Negative Brier deltas favor Poisson; every interval spans zero on the usable seasons.

| Season | Table Brier | Poisson 1.41 Brier | Delta, 95% CI |
|---|---:|---:|---:|
| 2022/23 (reduced) | 0.2005 | 0.2009 | +0.0005 [−0.0019, +0.0030] |
| 2023/24 | 0.1648 | 0.1629 | −0.0019 [−0.0049, +0.0009] |
| 2024/25 | 0.1760 | 0.1755 | −0.0006 [−0.0039, +0.0031] |
| 2025/26 | 0.1847 | 0.1829 | −0.0018 [−0.0046, +0.0009] |

This script is not a valid test of the earlier proposed 0.85 clean-sheet calibration. It hardcodes the raw table and does not evaluate the current Elo-based clean-sheet path or the shipped 0.75 compression. Interpolation was effectively tied; extrapolation was significantly worse in 2023/24 and 2024/25. No clean-sheet change is supported by this rerun.

### Attack clamp and team-goal sweep

The xP sample sizes are 9,872 / 9,905 / 10,030 / 9,972 player rows for 2022/23–2025/26. The current `[0.70, 1.35]` arm is exactly the `BASELINE` arm, so its zero delta is a duplicate, not a remeasurement of the historical choice to adopt that clamp. Wider windows did not resolve an xP improvement: for `[0.55, 1.75]`, deltas versus current were −0.0002 [−0.0036, +0.0032], +0.0023 [−0.0016, +0.0059], +0.0018 [−0.0020, +0.0054], and −0.0002 [−0.0018, +0.0011], respectively. Only 2022/23 is reduced by missing xG.

The team-goal block also hardcodes its reference as the old 1.03/0.97 venue pair with `[0.78, 1.22]`, while current production uses 1.102/0.898 and `[0.70, 1.35]`. Its arm comparisons are therefore stale and cannot justify a production change. This is an obsolete-arm finding, not a baseline parity failure.

### Elo FDR rerun

Each season supplied 660 or 662 team-fixtures and 9,872 / 9,905 / 10,030 / 9,972 xP rows. The 2022/23 and 2023/24 outputs are burn-in diagnostics; only 2024/25 and 2025/26 are valid Elo evaluations. Relative to `GAP(200)`, the FPL arm had lower xP RMSE in both evaluation seasons: −0.00744 [−0.01072, −0.00390] and −0.00380 [−0.00643, −0.00143]. Team-xG RMSE was unresolved in 2024/25 (−0.00125 [−0.00572, +0.00301]) and favored FPL in 2025/26 (−0.00530 [−0.01041, −0.00063]).

This does not establish that FPL difficulty should replace production Elo. The historical ratings are synthetic Elo, not ClubElo; the script rounds to integer FDR and sweeps divisors 130/200/300, while production uses real ClubElo, continuous FDR, and divisor 150. FPL-vs-Elo also changes both the rating source and formula. The current production formula is absent from the tested arms, so nothing here is ready to ship.

### `anchor.ts`

This script scores 5,356 / 5,442 / 5,410 player rows over GWs 20–38. Its labels are misleading: both arms use the same first-half player anchor, and they differ only in whether card deductions are enabled. All-player RMSE was 2.776 → 2.769 in 2023/24, 2.585 → 2.581 in 2024/25, and 2.638 → 2.638 in 2025/26. The script supplies no confidence intervals. It does not test player-anchor shrinkage or compare anchored with unanchored xP, so it cannot verify the earlier anchor-shrink suggestion.

## Limits

The 2022/23 corpus has no published xG before GW16. Its reported fixture/xP checks are reduced and cannot select constants. Elo was still converging through 2023/24, so Elo formula comparisons use only 2024/25 and 2025/26. `elo-fdr.ts` and `schedule-adjust.ts` use unseeded `Math.random()` bootstraps, so confidence-interval endpoints can move slightly across reruns; `cleansheets.ts` and `sweep.ts` use a fixed seed. No scripts or production code were changed for this rerun.
