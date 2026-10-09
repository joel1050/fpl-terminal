# Tier C: position-specific bonus scaling

## Baseline and method

The starting baseline was commit `74ceff274962102b5d774043b29783b22be13d75`: `projectPlayer()` multiplied every position's regressed bonus rate by the fixture attack multiplier. The candidate keeps that multiplier for GK/DEF and uses `1` for MID/FWD; every other projection term and rate is unchanged.

The comparison arm was fixed by the assignment, so there was no multiplier to fit. In prepared seasons with previous-player anchors, each player's bonus rate uses that prior-season anchor and only gameweeks before the scored fixture; 2022/23 lacks the anchor and is excluded. Predictions use actual minutes, and RMSE is measured per player-gameweek against total points and actual bonus points. Paired 95% intervals resample whole gameweek clusters (10,000 draws). The first scored week is GW6.

| Season | Rows | GW clusters | Role and limits |
|---|---:|---:|---|
| 2022/23 | 9,872 | 32 | Reduced diagnostic only: xG is missing before GW16, and this corpus has no previous-player anchor file, so it also falls back to target-season aggregates. Excluded from fitting and the decision. |
| 2023/24 | 9,905 | 33 | Earlier diagnostic; Elo burn-in. Its previous-player xG anchors also come from incomplete 2022/23. |
| 2024/25 | 10,030 | 33 | Held-out evaluation. |
| 2025/26 | 9,972 | 33 | Held-out evaluation. |

No parameter or threshold was selected from the held-out seasons. The assigned binary arm was evaluated as specified. The two Elo burn-in seasons are not used as converged-Elo evidence; the primary decision uses only 2024/25 and 2025/26.

The production parity gate passed at the starting commit on all 39,779 rows, with zero total or component difference. After the production change and harness update, it passed again on all 39,779 rows.

## Held-out results by position

Each delta is candidate RMSE minus starting-HEAD RMSE, so negative is better. Bonus bias is mean predicted bonus minus actual bonus.

| Season | Position | Rows | Whole-xP RMSE: baseline → candidate | ΔxP RMSE [95% CI] | Bonus RMSE: baseline → candidate | Δbonus RMSE [95% CI] |
|---|---|---:|---:|---:|---:|---:|
| 2024/25 | MID | 4,962 | 2.5118 → 2.5083 | −0.0034 [−0.0078, +0.0008] | 0.6226 → 0.6220 | −0.0006 [−0.0050, +0.0038] |
| 2024/25 | FWD | 1,104 | 3.0016 → 2.9857 | −0.0159 [−0.0291, −0.0028] | 0.9160 → 0.9134 | −0.0026 [−0.0134, +0.0085] |
| 2025/26 | MID | 4,612 | 2.5271 → 2.5250 | −0.0021 [−0.0055, +0.0010] | 0.6543 → 0.6554 | +0.0011 [−0.0019, +0.0039] |
| 2025/26 | FWD | 1,269 | 2.8148 → 2.8039 | −0.0109 [−0.0215, −0.0006] | 0.8215 → 0.8148 | −0.0067 [−0.0165, +0.0031] |

## Pooled held-out results

| Position | Rows | Whole-xP RMSE: baseline → candidate | ΔxP RMSE [95% CI] | Bonus RMSE: baseline → candidate | Δbonus RMSE [95% CI] | Bonus bias: baseline → candidate |
|---|---:|---:|---:|---:|---:|---:|
| All | 20,002 | 2.6484 → 2.6454 | −0.0030 [−0.0048, −0.0013] | 0.6461 → 0.6455 | −0.0006 [−0.0022, +0.0009] | +0.0154 → +0.0083 |
| MID+FWD | 11,947 | 2.6000 → 2.5949 | −0.0051 [−0.0081, −0.0022] | 0.6895 → 0.6886 | −0.0010 [−0.0035, +0.0015] | +0.0151 → +0.0034 |
| MID | 9,574 | 2.5192 → 2.5164 | −0.0028 [−0.0056, −0.0002] | 0.6380 → 0.6383 | +0.0003 [−0.0024, +0.0029] | +0.0154 → +0.0032 |
| FWD | 2,373 | 2.9032 → 2.8899 | −0.0133 [−0.0218, −0.0051] | 0.8668 → 0.8621 | −0.0047 [−0.0120, +0.0026] | +0.0140 → +0.0042 |
| GK | 1,335 | 2.6694 → 2.6694 | +0.0000 [+0.0000, +0.0000] | 0.6430 → 0.6430 | +0.0000 [+0.0000, +0.0000] | +0.0253 → +0.0253 |
| DEF | 6,720 | 2.7282 → 2.7282 | +0.0000 [+0.0000, +0.0000] | 0.5613 → 0.5613 | +0.0000 [+0.0000, +0.0000] | +0.0138 → +0.0138 |

The combined MID+FWD whole-xP gain resolves in both held-out seasons: −0.0060 [−0.0106, −0.0017] in 2024/25 and −0.0042 [−0.0079, −0.0006] in 2025/26. The separate pooled MID and FWD intervals also fall below zero. Bonus RMSE intervals include zero for every target-position comparison, while mean bonus bias moves closer to zero in the pooled target group.

## Earlier diagnostics and decision

In 2023/24, the combined MID+FWD whole-xP delta is +0.0011 [−0.0033, +0.0059] and bonus RMSE delta is +0.0032 [−0.0006, +0.0070]; neither resolves, and both point estimates favor the starting arm. In reduced 2022/23, the combined xP delta is +0.0058 [+0.0019, +0.0095], but that season is not a valid no-hindsight comparison for the reasons above. These conflicts are retained rather than averaged into the held-out result.

**Decision: ship flat MID/FWD bonus and retain fixture scaling for GK/DEF.** The pre-specified candidate lowers whole-xP RMSE for MID+FWD in both held-out seasons and in their pooled comparison. The bonus-only RMSE result is unresolved, so the evidence supports the whole-xP correction and reduced pooled bonus bias, not a claim that bonus forecasts themselves became more accurate. The training-season estimate remains a limitation, and later seasons could change the result.

## Rerun commands

Run from this worktree with the centrally prepared data left unchanged. Use `rc` for shell status in zsh; `status` is a read-only shell variable.

```sh
mkdir -p output/tier-c
for season in 2022-23 2023-24 2024-25 2025-26; do
  BACKTEST_DATA_DIR="/tmp/fpl-tier-c-seasons-20261008/$season" \
    npx tsx scripts/backtest/validate.ts \
    > "output/tier-c/validate-post-change-$season.log" 2>&1 || exit $?
done

for season in 2022-23 2023-24 2024-25 2025-26; do
  BACKTEST_DATA_DIR="/tmp/fpl-tier-c-seasons-20261008/$season" \
    npx tsx scripts/backtest/bonus-position.ts \
    --output "output/tier-c/bonus-$season.json" \
    > "output/tier-c/bonus-$season.log" 2>&1 || exit $?
done

npx tsx scripts/backtest/bonus-position.ts --pool held-out \
  output/tier-c/bonus-2024-25.json output/tier-c/bonus-2025-26.json \
  > output/tier-c/bonus-heldout-pool.log 2>&1
```

The experiment runner is `scripts/backtest/bonus-position.ts`. The parity harness now defaults to the production position rule; `run.ts`, `fit-conversions.ts`, `anchor.ts`, and `fwd-swing.ts` were aligned with that default. No data snapshots were edited.

Focused and full tests, typecheck, and lint pass. `test:e2e` could not start its web server, and `build` stopped before compilation, because this worktree's pre-existing `node_modules` symlink points to the main checkout, outside Turbopack's filesystem root. Lint still reports five unrelated existing warnings. The canonical calculations spec and backtest README were left untouched as requested; their universal fixture-bonus wording needs the parent-owned documentation handoff.
