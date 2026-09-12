# Goals against xG in the in-season team form signal — 2026-09-10

Run by `scripts/backtest/goals-vs-xg.ts` on the prepared 2022/23–2025/26 corpora
after `prepare-seasons.ts` and `elo-history.ts`. Walk-forward: every strength is
fitted only on gameweeks before the one scored. Team-level instrument, 660–662
team-fixtures per season over gameweeks 6–38, 2,642 pooled.

The question: replace or dilute the xG the in-season form fit reads with actual
goals, and give the opponent's attack more of a say. `calculations.md` §3.3
already records goals as tested and beaten, but no script defined that arm, so
the claim had nothing behind it and predated the parity repair of `316d270`.

## Verdicts

| Question | Verdict |
|---|---|
| Blend goals into the xG form signal | **Reject.** Every weight from 25% to 100% has a Brier interval crossing zero in all four seasons and pooled. The pooled best point estimate is 50% at -0.00020, which the corpus cannot resolve. |
| Replace xG with goals outright | **Reject**, but §3.3 overstates the loss. Pooled Brier is -0.00009, not the clear defeat that section describes. On whole-model xP it is worse in 2024/25 (+0.01410 [+0.00129, +0.02620]) and unresolved elsewhere. Goals are a wash on clean sheets and mildly harmful downstream, not a disaster. **§3.3 should be corrected.** |
| Steepen the opponent-attack multiplier (exponent above 1) | **Reject, resolved.** 1.2 costs +0.00152 [+0.00076, +0.00222] pooled and 1.4 costs +0.00370 [+0.00219, +0.00504]; both are worse in three of four seasons individually. |
| Flatten it (exponent below 1) | **Not a fixture finding.** See below: it is the overconfidence correction wearing a different hat. |
| Raise the goals-against level by a flat 5–15% | **Reject.** It chases the season's own clean-sheet rate: better in 2023/24 (rate 0.222), worse in 2022/23 (rate 0.285), unresolved in the middle two. Nothing knowable before a season starts picks the constant. |
| Compress the rated read toward the long-run rate | **Open lead, small.** Pooled, `0.25 + 0.85 * (p - 0.25)` is -0.00069 [-0.00120, -0.00004]. Negative in three seasons of four. |

## The exponent is not about the fixture

Flattening the opponent multiplier looked like the one live lead until the
control ran. Three things say it is not:

- **AUC never moves.** It is 0.638 pooled at every exponent from 0.6 to 1.4. The
  ordering of fixtures is untouched; only the spread of the probabilities changes.
- **A plain shrink buys the same thing.** `opponent^0.8` is -0.00074 pooled;
  shrinking the shipped read toward 0.25 at 0.85 is -0.00069. Near enough the
  same number by a mechanism that has nothing to do with the opponent.
- **They do not stack.** `opponent^0.8 + shrink 0.85` is -0.00079, not the
  -0.00143 two independent effects would give. One effect, two spellings.

So the finding underneath is that the **rated clean-sheet path is mildly
overconfident on this corpus**: its mean prediction is 0.274 against a measured
0.241–0.252. `calculations.md` §7.4 states the rated path "is calibrated at the
top by construction and is not compressed", and deliberately withholds the
`CLEAN_SHEET_RETAINED_WEIGHT` compression the 5x5 table path gets. That claim is
not supported here.

It is a lead and not a ship, because the correction is partly chasing the league
rate as well. 2022/23 realized 0.285 clean sheets — above the 0.25 shrink target
— and is the one season where shrinking is (trivially) worse: +0.00018. The
effect resolves pooled and in 2024/25 alone, and is unresolved in the other
three.

## Caveats

- Realized clean sheets are reconstructed as "opponent scored zero" from summed
  player goals, so own goals are missed and the measured rate is slightly
  generous. Measured rates run 0.222–0.285 by season; §7.4 quotes 0.270 for a
  full 2025/26 against 0.256 here over gameweeks 6–38.
- Goals-against RMSE improves with the exponent in 2023/24, 2024/25 and 2025/26
  but not in 2022/23 (1.2288 against a shipped 1.2266), and the improvement is
  carried almost entirely by the last two seasons (2024/25 1.1897 to 1.1628,
  2025/26 1.1275 to 1.0931).
- The Elo ratings are `elo-history.ts`'s own walk-forward ratings, not ClubElo's
  published numbers, so these verdicts are about the transformation.
- The whole-model xP table in the script output scores the 5x5 fallback
  clean-sheet path, because `xp.ts` carries no rated path. It is a downstream
  sanity check on the form signal, not a clean-sheet result.
- 2022/23 keeps the README's xG caveat: FPL published no xG before gameweek 16.

## Reproducing

```bash
BACKTEST_ROOT=$(mktemp -d)
BACKTEST_MULTI_DATA_DIR=$BACKTEST_ROOT npx tsx scripts/backtest/prepare-seasons.ts
BACKTEST_MULTI_DATA_DIR=$BACKTEST_ROOT npx tsx scripts/backtest/elo-history.ts
for season in 2022-23 2023-24 2024-25 2025-26; do
  BACKTEST_CASE_OUT=/tmp/cases-$season.json \
  BACKTEST_DATA_DIR=$BACKTEST_ROOT/$season npx tsx scripts/backtest/goals-vs-xg.ts
done
npx tsx scripts/backtest/goals-vs-xg.ts --pool /tmp/cases-*.json
```
