# Tier C: clean-sheet and goals-conceded distributions

Keep the shipped negative-binomial clean-sheet probability with the Poisson goals-conceded deduction. Poisson clean-sheet Brier is slightly better on the held-out seasons, but its paired interval spans zero and its pooled whole-xP RMSE is worse; applying NB(phi=12) to both events ties on xP and worsens the full-count likelihood.

## Baseline, arms, and parity

At HEAD `74ceff2`, production uses `P(CS) = (phi / (phi + lambda))^phi` with `phi = 12`, and keeps `lambda` as `expectedGoalsAgainst`. GK/DEF deductions use `E[floor(Poisson(lambda * minutesShare) / 2)]`. The consistent Poisson arm uses `exp(-lambda)` for clean sheets and the same Poisson deduction; the consistent NB arm uses the production phi shape for both, including at partial minutes (`mean = lambda * minutesShare`, fixed `phi = 12`).

The 2023/24 season selected phi by clean-sheet Brier from finite values 1–200 plus the Poisson limit; the minimum was the Poisson limit. That selection is reported as training only. 2024/25 and 2025/26 are held out. The paired 95% intervals use 4,000 gameweek-cluster resamples; the pooled bootstrap resamples 33 gameweeks within each held-out season.

The existing `validate.ts` gate passes exactly on all four corpora, but it covers the table fallback. This experiment also gates the rated production path, where enrichment supplies `cleanSheetStrengths`: parity is exact on 9,905 training rows, 10,030 2024/25 rows, and 9,972 2025/26 rows (worst total and component gaps are 0). The standard gate compared 9,872, 9,905, 10,030, and 9,972 rows respectively. All projections use observed minutes, as in the existing backtest harness.

## Clean-sheet and count metrics

`team-fixture sides` counts each defending team once per fixture. The baseline columns are absolute scores; deltas compare the named arm with the current mix.

| Split | Sides | CS Brier, current | Poisson Δ [95% CI] | Conceded-count NLL, current | NB(phi=12) Δ [95% CI] |
|---|---:|---:|---:|---:|---:|
| 2022/23 reduced | 488 | 0.19320 | +0.00065 [-0.00076, +0.00209] | 1.47901 | +0.00013 [-0.00675, +0.00646] |
| 2023/24 training | 662 | 0.16404 | -0.00148 [-0.00239, -0.00053] | 1.52403 | +0.00750 [+0.00124, +0.01309] |
| 2024/25 held out | 660 | 0.17607 | -0.00055 [-0.00155, +0.00045] | 1.48128 | +0.00487 [-0.00150, +0.01093] |
| 2025/26 held out | 660 | 0.18199 | -0.00015 [-0.00123, +0.00095] | 1.44533 | +0.00684 [+0.00132, +0.01223] |
| Pooled held out | 1,320 | 0.17903 | -0.00035 [-0.00111, +0.00037] | 1.46331 | +0.00585 [+0.00163, +0.00969] |

The Poisson clean-sheet logloss delta is -0.00124 [-0.00478, +0.00255] in 2024/25, +0.00043 [-0.00342, +0.00441] in 2025/26, and -0.00040 [-0.00301, +0.00236] pooled, so each interval spans zero. NB(phi=12) has the same clean-sheet probability as the current mix, so its event Brier and logloss are unchanged. For the count NLL, the current mix uses Poisson because that is the distribution behind its conceded deduction; NB is worse pooled and in 2025/26.

## Held-out xP metrics

The table reports whole-player RMSE at observed minutes. Deltas are paired against the current mix; negative is better.

| Split | xP rows | Current RMSE | Poisson Δ [95% CI] | NB(phi=12) Δ [95% CI] | GK/DEF current RMSE | Poisson Δ [95% CI] | NB(phi=12) Δ [95% CI] |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2024/25 | 10,030 | 2.60472 | -0.00157 [-0.00282, -0.00021] | -0.00016 [-0.00024, -0.00007] | 2.59821 | -0.00363 [-0.00700, -0.00031] | -0.00040 [-0.00062, -0.00018] |
| 2025/26 | 9,972 | 2.68330 | +0.00455 [+0.00325, +0.00592] | +0.00017 [+0.00009, +0.00024] | 2.81185 | +0.00886 [+0.00585, +0.01201] | +0.00039 [+0.00022, +0.00057] |
| Pooled held out | 20,002 | 2.64418 | +0.00153 [+0.00058, +0.00247] | +0.00001 [-0.00005, +0.00006] | 2.70882 | +0.00296 [+0.00065, +0.00520] | +0.00002 [-0.00013, +0.00015] |

Across 8,055 GK/DEF rows with per-match goals conceded, the current deduction RMSE is 0.55535; consistent NB changes it by +0.00010 [-0.00009, +0.00030]. Its xP result flips sign by season and pools to a tie. Poisson improves 2024/25 but loses more in 2025/26, so it does not generalize.

## Limits and decision

2022/23 is reduced to GW16–38 clean-sheet events, with neutral xG lean and no xP score, because its xG is incomplete and it lacks prepared previous-season player priors. 2023/24 is used only to select phi; its Elo is burn-in and its player anchors inherit incomplete 2022/23 xG. The holdouts use converged Elo seasons and prepared priors. Historical ClubElo ratings are unavailable, so the backtest uses the prepared synthetic walk-forward Elo inputs while passing their derived rates through production's actual rated path. That isolates distribution choice, but does not validate the historical Elo source.

No production change is supported: the Poisson clean-sheet event gains are unresolved, consistent NB worsens count NLL without improving pooled xP, and consistent Poisson raises pooled whole-xP RMSE. Production files remain untouched. The pooling script initially caught a stale arm label when the Poisson-limit fit was added; the label was corrected and the final run completed. `npm run typecheck` and `git diff --check` pass. `npm run lint` exits 0 with five existing warnings in `TerminalApp.tsx`, `difficulty-rungs.ts`, and `optimum-14.ts`; the new experiment files have none.

## Exact rerun

Run from the assigned worktree root; all prepared inputs are read-only, and JSON outputs and stdout logs stay under `output/tier-c/`.

```bash
mkdir -p output/tier-c

for season in 2022-23 2023-24 2024-25 2025-26; do
  BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/$season \
    npx tsx scripts/backtest/validate.ts \
    > output/tier-c/validate-final-$season.log 2>&1
done

BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2023-24 \
  TIER_C_CASES_OUT=output/tier-c/2023-24.json \
  npx tsx scripts/backtest/tier-c-conceded.ts \
  > output/tier-c/2023-24.log 2>&1

for season in 2022-23 2024-25 2025-26; do
  BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/$season \
    TIER_C_FIT_FILE=output/tier-c/2023-24.json \
    TIER_C_CASES_OUT=output/tier-c/$season.json \
    npx tsx scripts/backtest/tier-c-conceded.ts \
    > output/tier-c/$season.log 2>&1
done

npx tsx scripts/backtest/pool-tier-c-conceded.ts \
  output/tier-c/2022-23.json output/tier-c/2023-24.json \
  output/tier-c/2024-25.json output/tier-c/2025-26.json \
  > output/tier-c/summary.log 2>&1
```
