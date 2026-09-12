# The current-season weight on goalkeeper saves — 2026-09-10

Run by `scripts/backtest/saves-weight.ts` on the prepared 2022/23–2025/26
corpora. Walk-forward, gameweeks 2–38, 3,002 goalkeeper appearances pooled.
Scored on saves directly — the quantity the rate predicts — and on the points
they convert to, since FPL pays on `floor(saves / 3)`.

## Why it was untestable until now

`historical-match-stats.json` carried no per-match saves, so `currentBefore`
could not build a walk-forward save total and the harness skipped the
current-season blend for saves entirely. `season.ts` listed this in
`KNOWN_LEAKS` as "saves per-90: only a season aggregate exists per player, so it
is reused at every gameweek".

The ingest now carries `saves` on every match row, which removes that leak and
makes the blend measurable for the first time. `distributions.ts` records the
same gap for defensive-contribution dispersion; that one is still open, because
`defensive_contribution` per match is a separate column.

## Verdict: the shipped constant is already right. Nothing to change.

Pooled, all gameweeks:

| Arm | saves RMSE | ΔRMSE | 95% CI | verdict |
|---|---|---|---|---|
| **shipped `n/(n+6)`** | **1.89965** | — | — | — |
| `n/(n+2)` | 1.90926 | +0.00961 | [+0.00281, +0.01599] | **worse** |
| `n/(n+4)` | 1.90225 | +0.00260 | [−0.00010, +0.00502] | ns |
| `n/(n+10)` | 1.89840 | −0.00125 | [−0.00422, +0.00227] | ns |
| `n/(n+15)` | 1.89909 | −0.00057 | [−0.00572, +0.00580] | ns |
| `n/(n+20)` | 1.90038 | +0.00073 | [−0.00584, +0.00905] | ns |
| `n/(n+45)` | 1.90615 | +0.00650 | [−0.00330, +0.01866] | ns |
| anchor's own matches | 1.90378 | +0.00412 | [−0.00362, +0.01138] | ns |
| previous season only | 1.91885 | +0.01920 | [+0.00542, +0.03552] | **worse** |

The curve is flat and at its minimum between 6 and 15, and both ends are
resolved against: leaning harder on a short current-season sample (`n/(n+2)`) is
worse, and ignoring the current season altogether is worse still. No alternative
has an interval excluding zero in the better direction, so there is no optimum
to move to.

**The evidence-weighted arm loses too.** Weighting the anchor by the matches it
was actually built from — so a keeper with a full previous season needs a full
season to overturn it — is the principled alternative, and the reason `n/(n+6)`
looks wrong at two matches. It scores +0.00412, unresolved but on the wrong
side. The intuition that a dozen saves should not outweigh a previous season's
ninety is not what the outcomes say.

## The early-season window does not rescue the hypothesis

Gameweeks 2–5 are where a two-match sample carries most of its weight, so that
is where a mis-set constant should show. Pooled over four seasons, 320
appearances, **every arm is unresolved** and the point estimates do not order
themselves sensibly (`n/(n+4)` −0.00216, `n/(n+10)` +0.00601, `n/(n+2)`
+0.00464).

2025/26 alone looked like a real finding in that window — `n/(n+2)` and
`n/(n+4)` both resolved *better*, and every larger weight resolved worse, which
points the opposite way from the hypothesis that the current season is
overweighted. Pooling the other three seasons erases it. One season's early
window is 81 appearances; it was noise.

## What this means for the goalkeeper who prompted it

The ablation in the session that led here showed that removing this season's
saves drops Chelsea's Martinez from 1st to 4th on the 10-gameweek table. That
observation stands. What does not stand is the inference drawn from it — that
the blend weight is set too high. Both are true at once: the weight is right on
average across 3,002 appearances, and one keeper's two-match sample is extreme
(6.00 saves per 90 against a career 3.02). A correctly weighted blend still
moves a long way when the new evidence is a long way out.

If his projection is still wrong, the cause is not this constant, and the
remaining candidates from the diagnosis are untouched by this run:

- The saves environment clamp. `clamp(xGA / 1.35, 0.7, 1.4)` clamps Chelsea's
  0.60 up to 0.70, a 17% boost the model's own goals-against does not support.
- The incoherence between the two halves: 3.09 shots faced against 0.81 goals
  conceded is a 73.7% implied save percentage, the highest in the field, while
  the same model gives Raya 57.3%. Saves come from player history and
  goals-against from the team model, and nothing reconciles them.

The second is the larger and the harder, and it is a modelling change rather
than a constant.

## Caveats

- Actual minutes are used, as in `run.ts`, so the minutes model does not bury
  the signal. Absolute RMSE is therefore better than a live model would manage;
  only the differences between arms are the result.
- Saves points RMSE moves in the same direction as saves RMSE in every arm, so
  the threshold conversion is not hiding anything.
- The shipped arm over-predicts saves by 0.121 per appearance pooled. Small, and
  no arm here fixes it.

## Reproducing

```bash
for season in 2022-23 2023-24 2024-25 2025-26; do
  BACKTEST_CASE_OUT=/tmp/sv-$season.json \
  BACKTEST_DATA_DIR=$BACKTEST_ROOT/$season npx tsx scripts/backtest/saves-weight.ts
done
npx tsx scripts/backtest/saves-weight.ts --pool /tmp/sv-*.json
```
