# Tier C: goalkeeper save-volume denominator

## Decision

Keep the shipped denominator at **1.35**. The training-only fit did not resolve
an improvement in either saves RMSE or goalkeeper xP. The fixed 1.408 reference
reduced pooled saves RMSE, but its pooled GK xP interval spans zero, and the
code documents 1.408 as the mean from all 380 fixtures of 2025/26. Treat that
arm as descriptive, not as held-out evidence for changing production.

## Shipped behavior and arms

At HEAD `74ceff274962102b5d774043b29783b22be13d75`, production computes
`savesEnvironment = clamp(expectedGoalsAgainst / 1.35, 0.7, 1.4)` in
`lib/projections/projectPlayer.ts`. `lib/projections/fixtureAdjustment.ts` also
has `LEAGUE_MEAN_XG = 1.408`; that is a separate fixture-model constant, not the
save denominator.

The experiment kept the projected goals-against value, save rate, minutes, and
all other xP components fixed. It compared:

- **Shipped:** denominator 1.35.
- **League-xG reference:** denominator 1.408, as requested. The current code
  says this value was measured from the full 2025/26 fixture set, so it is not
  an independent prospective candidate.
- **Training-only fit:** denominator selected to minimize actual-save RMSE over
  earlier seasons only, using a 0.50–3.00 grid in 0.001 steps.

Predicted saves are `saveRate × minutesShare × clamp(xGA / denominator, 0.7,
1.4)`. GK xP replaces only the saves-points component with the model's expected
`floor(saves / 3)` points, then compares total expected points with actual
FPL points. Actual minutes isolate this environment term from the minutes
model.

## Data and parity

The prepared corpus was read from `/tmp/fpl-tier-c-seasons-20261008`; no files
there were changed. `validate.ts` passed against production at this worktree's
HEAD on all seasons: 9,872 rows for 2022/23, 9,905 for 2023/24, 10,030 for
2024/25, and 9,972 for 2025/26, with zero total or component gap. The experiment
also checked production parity on every scored GK row: zero gap on 678 rows in
2023/24, 669 in 2024/25, and 666 in 2025/26.

Evaluation covers GW6–38 and rows with actual minutes and per-match saves.
There were no eligible GK rows missing saves. To avoid using the incomplete
2022/23 xG corpus, it was excluded from fitting and outcome evaluation. The
2023/24 Elo burn-in values do not enter this experiment: `season.ts` builds the
strengths from walk-forward xG, not `backtest-elo.json`. Training starts at
GW11 to reduce dependence on opening-season team priors.

For 2024/25, the fit used 576 GK appearances from 2023/24 GW11–38 and produced
**1.359**. For 2025/26, it used 1,144 appearances from 2023/24 and 2024/25
GW11–38 and produced **1.462**. Each held-out season has 33 gameweek clusters.
The pooled result covers 1,335 GK appearances and 66 season-gameweek clusters.

Intervals are 4,000 paired bootstrap draws, resampling gameweek clusters within
each season. Deltas are candidate RMSE minus shipped RMSE, so negative favors
the candidate.

## Held-out results

| Held-out season | Arm | Saves RMSE | Δ saves RMSE [95% CI] | GK xP RMSE | Δ GK xP RMSE [95% CI] |
|---|---|---:|---:|---:|---:|
| 2024/25 (669) | Shipped 1.35 | 1.92448 | — | 2.69818 | — |
|  | Reference 1.408 | 1.91216 | −0.01232 [−0.02003, −0.00462] | 2.69660 | −0.00158 [−0.00474, +0.00131] |
|  | Training fit 1.359 | 1.92246 | −0.00202 [−0.00324, −0.00079] | 2.69794 | −0.00025 [−0.00075, +0.00021] |
| 2025/26 (666) | Shipped 1.35 | 1.79077 | — | 2.64022 | — |
|  | Reference 1.408 | 1.78867 | −0.00210 [−0.01009, +0.00588] | 2.64021 | −0.00001 [−0.00238, +0.00245] |
|  | Training fit 1.462 | 1.79006 | −0.00071 [−0.01577, +0.01331] | 2.64101 | +0.00079 [−0.00357, +0.00510] |
| Pooled (1,335) | Shipped 1.35 | 1.85898 | — | 2.66942 | — |
|  | Reference 1.408 | 1.85158 | −0.00739 [−0.01289, −0.00192] | 2.66861 | −0.00081 [−0.00281, +0.00106] |
|  | Training fit (season-specific) | 1.85759 | −0.00139 [−0.00893, +0.00543] | 2.66969 | +0.00027 [−0.00191, +0.00244] |

The reference arm improves saves RMSE on the pooled rows, driven mainly by
2024/25, but there is no resolved GK xP gain in either season or pooled. The
training-only fit is unresolved on both metrics pooled and changes direction on
GK xP between the held-out seasons. The data do not support a production change.

## Limits

- 2022/23 has incomplete xG, so it could not be used as training evidence for a
  denominator that scales modelled xGA.
- The 2023/24 opening-season prior follows 2022/23 data; dropping GW1–10 reduces
  but does not erase that upstream limitation in the 2023/24 training rows.
- The fixed 1.408 reference comes from the full 2025/26 season according to the
  production comment. Its metrics are included for the requested comparison,
  but they cannot justify a prospective change.
- This evaluates two held-out seasons and one training-only fit rule. A small
  saves-RMSE change does not imply a points gain because FPL awards saves in
  three-save thresholds and the environment ratio is clamped.

## Reproduction

Run from this worktree. The commands below validate the actual shipped baseline,
collect immutable per-season cases, and write all stdout/stderr logs under
`output/tier-c/`:

```bash
mkdir -p output/tier-c
for season in 2022-23 2023-24 2024-25 2025-26; do
  BACKTEST_DATA_DIR="/tmp/fpl-tier-c-seasons-20261008/$season" \
    ./node_modules/.bin/tsx scripts/backtest/validate.ts \
    > "output/tier-c/validate-$season.log" 2>&1 || exit $?
done
for season in 2023-24 2024-25 2025-26; do
  BACKTEST_DATA_DIR="/tmp/fpl-tier-c-seasons-20261008/$season" \
  BACKTEST_CASE_OUT="output/tier-c/cases-$season.json" \
    ./node_modules/.bin/tsx scripts/backtest/tier-c-saves.ts \
    > "output/tier-c/collect-$season.log" 2>&1 || exit $?
done
./node_modules/.bin/tsx scripts/backtest/tier-c-saves.ts \
  --pool output/tier-c/cases-2023-24.json \
        output/tier-c/cases-2024-25.json \
        output/tier-c/cases-2025-26.json \
  > output/tier-c/analysis.log 2>&1 || exit $?
./node_modules/.bin/tsc --noEmit > output/tier-c/typecheck.log 2>&1 || exit $?
./node_modules/.bin/eslint scripts/backtest/tier-c-saves.ts > output/tier-c/eslint.log 2>&1 || exit $?
```
