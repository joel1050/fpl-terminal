# Tier C: player-anchor pool shrinkage

## Decision

The reported `-0.0237` RMSE gain does not reproduce with genuine adjacent-season anchors. The 2025/26 held-out player-season xGI/90 change is `-0.00357` RMSE with a 95% interval of `[-0.01048, +0.00067]`; xP changes by `-0.00096` with an interval of `[-0.00343, +0.00140]`. The xP result is unresolved, so production remains unchanged.

## Design

The baseline is the shipped `projectPlayer()` implementation at HEAD `74ceff2`: it regresses a player's prior-season xG/xA rate toward the production price-tier prior with 900 minutes of prior weight. `validate.ts` matched production component by component on all four prepared seasons, with zero maximum gap across 39,779 played rows.

The candidate regresses the same anchor toward a leave-one-out, position-level pool rate from the immediately preceding season. Its prior weight is selected on 2024/25 and then held fixed for 2025/26. The pool uses only preceding-season records and stable-code prepared anchors; no target-season aggregate supplies a prior. Historical prices are absent from these corpora, so `playerAt()`'s £5.0m placeholder feeds the shipped price-tier prior in every baseline row.

The fit used the unweighted RMSE of player-season xGI/90, with each player's target rate recomputed from resampled target gameweek clusters. The tested pool prior weights were 0, 225, 450, 900, 1,800, 3,600, 7,200, and 14,400 minutes; 900 won on 2024/25 (`0.32657` versus `0.33186` shipped, delta `-0.00529`). Confidence intervals use 4,000 paired gameweek-cluster bootstrap draws. The xP arm uses the same selected weight and scores player-fixture points at observed minutes.

## Results

Negative deltas favor the pool arm. The 2024/25 season is the fit set; 2025/26 is the held-out test. “Player-season anchor” scores one prior-only xGI/90 prediction per matched player against that player's following season. “Anchor rate” scores the fixed prior-only prediction against each target appearance, weighted by minutes. xP uses walk-forward current-season form and the shipped scoring model.

| Season | Measure | n | Shipped RMSE | Pool RMSE | Delta, 95% paired GW CI |
|---|---|---:|---:|---:|---:|
| 2024/25 fit | Player-season anchor xGI/90 | 352 players | 0.33186 | 0.32657 | -0.00529 `[-0.01069, +0.00077]` |
| 2024/25 fit | Anchor rate xGI/90 | 8,401 appearances | 0.35403 | 0.35283 | -0.00120 `[-0.00234, -0.00001]` |
| 2024/25 fit | xP at observed minutes | 8,401 appearances | 2.72732 | 2.73013 | +0.00281 `[+0.00044, +0.00523]` |
| 2025/26 held out | Player-season anchor xGI/90 | 343 players | 0.11864 | 0.11507 | -0.00357 `[-0.01048, +0.00067]` |
| 2025/26 held out | Anchor rate xGI/90 | 8,220 appearances | 0.35884 | 0.35668 | -0.00216 `[-0.00330, -0.00108]` |
| 2025/26 held out | xP at observed minutes | 8,220 appearances | 2.79664 | 2.79568 | -0.00096 `[-0.00343, +0.00140]` |
| Pooled¹ | Player-season anchor xGI/90 | 695 players | 0.25045 | 0.24606 | -0.00438 `[-0.00882, -0.00132]` |
| Pooled¹ | Anchor rate xGI/90 | 16,621 appearances | 0.35642 | 0.35474 | -0.00168 `[-0.00245, -0.00086]` |
| Pooled¹ | xP at observed minutes | 16,621 appearances | 2.76182 | 2.76274 | +0.00092 `[-0.00079, +0.00265]` |

¹ Pooled combines the fit and test seasons, so it is descriptive and not an independent confirmation. The held-out result is the decision metric.

The prior-only rate improvement is materially smaller than the quoted `0.0237`, and it does not carry through to held-out xP. The prior-only pooled interval excludes zero, but it includes the season used to select the weight; the held-out interval crosses zero. No production change is supported.

## Coverage and limits

The usable adjacent pairs are 2023/24 → 2024/25 and 2024/25 → 2025/26. 2022/23 has no prepared adjacent-anchor file, and 2023/24 was not used as a target because its 2022/23 xG anchor is incomplete. That leaves one fit season and one held-out season. The target xP seasons are outside the 2022/23–2023/24 Elo burn-in, but the sample still covers only 38 gameweek clusters per season.

The xP metric conditions on observed minutes and historical player matches with usable xG/xA anchors; it does not test minutes or availability changes. Historical prices are unavailable, so the parity gate proves the harness matches shipped code at the £5.0m placeholder, not at each player's historical market price. The pool arm only changes the backtest helper; no production module changed.

## Rerun

Run from this worktree with the centrally prepared data unchanged:

```bash
for s in 2022-23 2023-24 2024-25 2025-26; do
  BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/$s npx tsx scripts/backtest/validate.ts > output/tier-c/validate-final-$s.log 2>&1
done

BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2024-25 npx tsx scripts/backtest/tier-c-anchor.ts 2024-25 --sweep > output/tier-c/fit-2024-25.log 2>&1
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2024-25 npx tsx scripts/backtest/tier-c-anchor.ts 2024-25 --weight=900 > output/tier-c/metrics-2024-25.log 2>&1
BACKTEST_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008/2025-26 npx tsx scripts/backtest/tier-c-anchor.ts 2025-26 --weight=900 > output/tier-c/metrics-2025-26.log 2>&1
npx tsx scripts/backtest/tier-c-anchor.ts aggregate --aggregate 900 > output/tier-c/pooled.log 2>&1
npx tsc --noEmit > output/tier-c/typecheck-final.log 2>&1
npx eslint scripts/backtest/xp.ts scripts/backtest/tier-c-anchor.ts > output/tier-c/lint-final.log 2>&1
```

In zsh, capture an exit code in `rc`; `status` is read-only. The first fit attempt also used a stale `-1` sentinel after switching the baseline selector; that output is retained in `output/tier-c/fit-2024-25-pre-fix.log` and excluded. The corrected baseline uses the shipped price-tier prior, and all reported runs use the corrected selector. `scripts/backtest/xp.ts` only gained separate, optional anchor-pool inputs and their weight; its default path is unchanged and continues to pass production parity.
