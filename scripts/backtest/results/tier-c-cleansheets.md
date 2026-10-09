# Tier C: clean-sheet shrink on the rated path

**Decision: do not ship the 0.85 shrink.** Against the production rated path at HEAD, it moves held-out clean-sheet Brier in the right direction by a small, unresolved amount, and held-out xP is also unresolved. The earlier `-0.00069` result reproduces only in the older exploratory transform.

## Method and gate

HEAD was `74ceff274962102b5d774043b29783b22be13d75`. The baseline calls the current `deriveCleanSheetStrengths()`, `calculateFixtureAdjustment()`, and `projectPlayer()` code. The proposed arm applies `p' = 0.25 + 0.85 * (p - 0.25)` to rated clean-sheet probabilities, then re-derives the negative-binomial goals-against mean so clean-sheet and conceded-goal points use a consistent fixture mean. For the xP comparison, every scored player's actual minutes are held fixed.

The existing `validate.ts` parity gate passed at zero difference on all prepared rows: 9,872 (2022/23), 9,905 (2023/24), 10,030 (2024/25), and 9,972 (2025/26), 39,779 total. That gate exercises its table fallback. The new experiment calls production `projectPlayer()` directly with the rated strengths and checks the proposed xP decomposition against direct projection on every collected row.

Clean-sheet outcomes are counted once per team-fixture; xP uses one row per played player-fixture. Confidence intervals are paired 95% gameweek-cluster bootstraps, stratified by season. Strength and Elo inputs use only earlier gameweeks. To choose a shrink amount without using test outcomes, the scalar was fit on 2024/25 GW6–19 (278 team-fixtures), the first usable converged-Elo training window; evaluation uses 2024/25 GW20–38 and 2025/26 GW6–38.

## Results

The old `goals-vs-xg.ts` pooling command reproduces its historical headline exactly: Brier `0.18124 → 0.18055`, delta `-0.00069` [−0.00120, −0.00004] across 2,642 team-fixtures. Its hand-built clean-sheet strengths omit the later production level blend, so this is not the current shipped path.

On the current rated path, the proposed 0.85 arm scores as follows. Delta is arm minus shipped; a negative value is better.

The full GW6–38 current-path results are exploratory because two seasons have the stated input limits; they show why the pooled claim should not set the verdict.

| Season / pool | Team-fixtures | Shipped Brier | 0.85 Brier | Delta [95% CI] |
|---|---:|---:|---:|---:|
| 2022/23, reduced | 660 | 0.19743 | 0.19768 | +0.00025 [−0.00055, +0.00107] |
| 2023/24, Elo burn-in | 662 | 0.16409 | 0.16361 | −0.00048 [−0.00195, +0.00087] |
| 2024/25, full season | 660 | 0.17623 | 0.17527 | −0.00096 [−0.00210, +0.00018] |
| 2025/26, full season | 660 | 0.18203 | 0.18149 | −0.00054 [−0.00167, +0.00070] |
| Pooled exploratory | 2,642 | 0.17993 | 0.17950 | −0.00043 [−0.00101, +0.00014] |

| Evaluation | Team-fixtures | Shipped Brier | 0.85 Brier | Delta [95% CI] |
|---|---:|---:|---:|---:|
| 2024/25, GW20–38 | 382 | 0.17228 | 0.17216 | −0.00012 [−0.00146, +0.00130] |
| 2025/26, GW6–38 | 660 | 0.18203 | 0.18149 | −0.00054 [−0.00174, +0.00071] |
| Held-out pooled | 1,042 | 0.17846 | 0.17807 | −0.00039 [−0.00127, +0.00053] |

The held-out mean probability falls from 0.274 to 0.271 against an observed rate of 0.253, so the shrink reduces but does not remove the overall over-prediction. It improves the upper bins, where the shipped mean is 0.351 against 0.324 actual for probabilities 0.30–0.40, and 0.446 against 0.393 for 0.40–0.50. In the lowest bin it moves the mean from 0.142 to 0.158 against 0.145 actual, so that part becomes over-predicted.

The fitted training weight was 0.4862, with training Brier 0.17740 versus 0.18165 shipped. It did not carry to held-out data: pooled held-out Brier worsened by +0.00160 [−0.00128, +0.00469]. This is evidence against choosing a stronger shrink from the training window.

| Held-out xP, actual minutes | Player-fixtures | Shipped RMSE | 0.85 RMSE | Delta [95% CI] |
|---|---:|---:|---:|---:|
| 2024/25, GW20–38 | 5,809 | 2.56866 | 2.56839 | −0.00027 [−0.00416, +0.00377] |
| 2025/26, GW6–38 | 9,972 | 2.68881 | 2.68786 | −0.00095 [−0.00348, +0.00147] |
| Held-out pooled | 15,781 | 2.64522 | 2.64451 | −0.00071 [−0.00279, +0.00142] |

The fitted 0.4862 arm worsened pooled held-out xP by +0.00455 [−0.00217, +0.01127]. Neither xP result resolves a gain, and the fixed 0.85 arm's Brier intervals also cross zero in both held-out seasons.

## Limits and rerun

Historic ClubElo snapshots are unavailable, so the rated transform uses the prepared walk-forward synthetic Elo series. This tests the current production transform with its historical proxy input, not the real ClubElo ratings. The 2022/23 xG corpus is incomplete through GW15, and 2022/23–2023/24 Elo is burn-in; those seasons appear only in the exploratory pooled reproduction and do not set the arm or held-out verdict. `validate.ts`'s parity result is for its standard projection path; the rated-path check here is direct production projection.

Run from this worktree; each season needs its own process because the backtest data directory is captured at module import. The central `/tmp` inputs are read-only.

```bash
for season in 2022-23 2023-24 2024-25 2025-26; do
  BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/$season \
  npx tsx scripts/backtest/validate.ts \
    > output/tier-c/validate-$season.log 2>&1
done

for season in 2022-23 2023-24 2024-25 2025-26; do
  BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/$season \
  BACKTEST_CASE_OUT=output/tier-c/rated-$season.json \
  npx tsx scripts/backtest/clean-sheet-shrink-heldout.ts \
    > output/tier-c/rated-$season.log 2>&1
done

npx tsx scripts/backtest/clean-sheet-shrink-heldout.ts --pool \
  output/tier-c/rated-2022-23.json \
  output/tier-c/rated-2023-24.json \
  output/tier-c/rated-2024-25.json \
  output/tier-c/rated-2025-26.json \
  > output/tier-c/rated-pooled.log 2>&1

for season in 2022-23 2023-24 2024-25 2025-26; do
  BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/$season \
  BACKTEST_CASE_OUT=output/tier-c/exploratory-$season.json \
  npx tsx scripts/backtest/goals-vs-xg.ts \
    > output/tier-c/exploratory-$season.log 2>&1
done

npx tsx scripts/backtest/goals-vs-xg.ts --pool \
  output/tier-c/exploratory-2022-23.json \
  output/tier-c/exploratory-2023-24.json \
  output/tier-c/exploratory-2024-25.json \
  output/tier-c/exploratory-2025-26.json \
  > output/tier-c/exploratory-pooled.log 2>&1
npm run typecheck
```

No production files or canonical calculation docs changed. The only code addition is the experiment harness; run logs and case files remain under `output/tier-c/`.
