# A team's own clean-sheet rate as a defensive signal — 2026-09-10

Run by `scripts/backtest/cs-rate-signal.ts` on the prepared corpora, evaluation
seasons 2023/24–2025/26 (the arm needs a previous season for its prior, so
2022/23 has none). Walk-forward, 660–662 team-fixtures per season, 1,982 pooled.

The question: the shipped read predicts clean sheets through a goals-against
mean fitted on xG, and assumes every team converts that mean into clean sheets
the same way. Use each team's realized clean-sheet rate instead — previous
season as the prior, current season decayed and schedule-adjusted — and let it
correct the mean.

## Verdict: reject

| Route | Pooled | Reading |
|---|---|---|
| Straight onto the fixture's goals-against mean | **Worse, resolved.** +0.00164 at weight 0.5, +0.00338 at 0.75, +0.00566 at 1. | The honest test of the idea, and it fails. |
| Into the strengths' defence, where it would have to live to ship | **Flat.** -0.00012 to +0.00040, every interval crossing zero. | Damped to about 0.3 of the correction by the skew transform, and the damping is all that saves it. |

## The ordering is what gives it away

AUC falls monotonically with the weight on the direct route — 0.648 shipped,
then 0.645, 0.640, 0.633, 0.625. The signal is not mis-levelled; it is actively
scrambling which fixtures are the good ones. That is the variance cost arriving
exactly where the arithmetic said it would: a clean sheet is one bit a match,
and fifteen bits will not rank twenty defences.

It is worth being precise that this is a different failure from the exponent
arms in `results/goals-vs-xg.md`. Those left AUC untouched at 0.638 and only
moved the spread. This one destroys the ordering, so no recalibration rescues it.

## The damped route flips by season, and for a knowable reason

| Season | Previous-season CS rate (the prior) | Realized | `via skew` at 0.5 |
|---|---|---|---|
| 2023/24 | 0.284 | 0.222 | **-0.00118 [-0.00212, -0.00023]**, and AUC rises 0.666 to 0.671 |
| 2024/25 | 0.218 | 0.244 | -0.00025, unresolved |
| 2025/26 | 0.245 | 0.256 | **+0.00116 [+0.00002, +0.00221]** |

2023/24 is the one season where the arm has a real case: it improved both
calibration and ordering there. But the seasons it helps are the ones where last
year's league-wide clean-sheet rate happened to point the same way as this
year's, which is not knowable in advance. Three seasons, two of them resolved in
opposite directions, nothing pooled — that is a coin flip with a story attached.

## Caveats

- Realized clean sheets are reconstructed as "opponent scored zero" from summed
  player goals, so own goals are missed and the measured rate is slightly
  generous.
- The current-season rate is schedule-adjusted by the weighted mean attacking
  strength of the opponents actually faced, mirroring `adjustedMatchXG` on the
  xG side. Without it a team off an easy run reads as a better defence.
- The direct route also shifts the level: pooled mean prediction falls from
  0.275 to 0.262 at full weight. The AUC collapse is the decisive part, and it
  does not depend on that shift.
- Three evaluation seasons, not four, so this resolves less than the goals test.
- Elo ratings are `elo-history.ts`'s walk-forward ratings, not ClubElo's
  published numbers.

## Reproducing

```bash
for season in 2023-24 2024-25 2025-26; do
  BACKTEST_CASE_OUT=/tmp/cs-$season.json \
  BACKTEST_DATA_DIR=$BACKTEST_ROOT/$season npx tsx scripts/backtest/cs-rate-signal.ts
done
npx tsx scripts/backtest/cs-rate-signal.ts --pool /tmp/cs-*.json
```
