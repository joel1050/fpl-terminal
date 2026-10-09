# Tier C: current-role start probability

## Result

Remove the 240-minute start-frequency override. Continuing the previous-season-
seeded EWMA improves start Brier in all three adjacent-season evaluations and
in the 2024/25–2025/26 holdout. Keep the existing 240-minute cameo and expected
start-duration behavior; this experiment did not measure those calculations.

Delta is legacy-override Brier minus shipped Brier; positive means removing the
start override improves calibration. Both arms use the same cameo and duration
calculations and normalize start/cameo probabilities together. Intervals are
paired 95% bootstrap intervals resampling whole gameweeks, with 2,000 draws.

| Target season | Prior-season anchors | Player-GWs | Starts / DNP / short appearances | Gate active | Shipped Brier | Legacy override Brier | Delta [95% CI] |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2023/24 | 420 | 28,742 | 7,673 / 17,656 / 3,413 | 11,927 (41.5%) | 0.09106 | 0.10943 | +0.01837 [+0.01496, +0.02167] |
| 2024/25 | 423 | 27,231 | 7,742 / 15,800 / 3,689 | 11,955 (43.9%) | 0.09686 | 0.11169 | +0.01483 [+0.01227, +0.01734] |
| 2025/26 | 415 | 29,338 | 7,738 / 17,977 / 3,623 | 11,990 (40.9%) | 0.08998 | 0.10595 | +0.01597 [+0.01273, +0.01937] |
| **2024/25–2025/26 holdout** | — | **56,569** | — | — | **0.09329** | **0.10871** | **+0.01542 [+0.01318, +0.01748]** |
| All three anchored seasons | — | 85,311 | 23,153 / 51,433 / 10,725 | 35,872 (42.0%) | 0.09254 | 0.10896 | +0.01642 [+0.01461, +0.01824] |

The difference is concentrated where the 240-minute gate fires. On those
predictions, the legacy override loses by +0.04426 in 2023/24, +0.03378 in
2024/25, and +0.03908 in 2025/26; before the gate the arms match to production's
three-decimal probability rounding. The shipped candidate uses the production
selection output, while the evaluator reconstructs the legacy start frequency
and asserts candidate parity on every prediction.

## Method and coverage

The evaluator calls `buildPlayerSelections` for the shipped arm. Its legacy arm
uses the raw current-season start frequency after 240 eligible minutes and the
same `START_RATE_ALPHA` recursion before that point. Both arms share the exact
same role-cameo calculation, fallback mix, and start/cameo normalization. The
candidate parity assertion checks the production result against the EWMA arm on
every prediction. It uses only completed gameweeks before the prediction,
applies the production `minutes >= 60` start label, and supplies no FPL
availability, injury, or RotoWire data.

The inputs were the prepared adjacent-season corpora in
`/tmp/fpl-tier-c-seasons-20261008`: 2022/23 anchors 2023/24, 2023/24 anchors
2024/25, and 2024/25 anchors 2025/26. The three target corpora contain 87,087
player-fixture rows, all linked to a fixture; they yield 85,311 player-GWs
after aggregating double-gameweek targets. The outcome set includes zero-minute
and short-appearance rows. As in production, a team's double gameweek does not
update role history. The season GWs form the bootstrap clusters, and the two
later seasons are the holdout; no threshold or alpha was fitted on them.

## Limits

The historical source exposes player minutes and season-total starts, not a
timestamped official starting-XI flag for every match. The evaluated outcome is
therefore the same 60-minute proxy the production loader uses, including its
known classification of a starter substituted before 60 minutes as a non-start.
Rows reflect the historical corpus's player coverage, which may differ from
the live FPL element list. For transfers, role history is restricted to rows
for the target club, matching the production team filter as closely as the
archive allows; archived event-time roster membership is unavailable. The
model comparison intentionally excludes injury and lineup evidence so neither
arm benefits from hindsight. It does not test the retained cameo-frequency or
start-duration threshold.

## Reproduction

```bash
BACKTEST_MULTI_DATA_DIR=/tmp/fpl-tier-c-seasons-20261008 \
  npx tsx scripts/backtest/role-switch.ts
```

The full per-season output is in `output/tier-c/role-switch.log`. Candidate
parity assertions passed across all predictions after the production edit,
`npx vitest run tests/data/selection.test.ts` passed (21 tests), and
`npx tsc --noEmit` passed.
