# Where the clean-sheet read takes its level from — 2026-09-10

Run by `scripts/backtest/cs-level-source.ts` on the prepared 2022/23–2025/26
corpora. Walk-forward, gameweeks 2–38, 740 team-fixtures a season, 2,960 pooled.
This is the only script in the suite that scores gameweeks 2–5; every other one
starts at 6.

## The defect

`deriveCleanSheetStrengths` took the goal-scale level entirely from ClubElo and
read only the lean — attack against defence — from this season's xG. Two
consequences follow, and both are bad:

- A side whose attack and defence have **both** declined is a worse team with an
  unchanged lean, so its clean-sheet rating does not move at all.
- Because defence enters as `exp((level − 0.6·lean)/2)`, a side whose attack
  falls faster than its defence is rated as defending **better**.

Observed live, not hypothesised. At gameweek 4 of 2026/27, Chelsea had conceded
7 in 3 with 1.63 xG against per match, and sat 5th of 20 on this rating at every
strength prior weight from 12 down to zero — the rating *rose* from 1.102 to
1.189 as the season's evidence was given more weight.
`scripts/experiments/diagnose-gk-defence.ts` reproduces it for any team.

## The change

```
level = (1 − w)·eloLevel + w·fittedLevel        w = n / (n + 12)
fittedLevel = log(attack) + log(defence), centred and stretched to Elo's spread
```

The stretch is not optional. The module docstring records that these normalized
ratios carry a level spread 1.69× narrower than a direct Poisson fit on the same
xG; handing them the level raw would re-order the teams while quietly pulling
them together, which is the mistake the first cut of that module made.

Elo still owns the level early, which is what it is there for — Hull, Coventry
and Ipswich have no top-flight goal history to fit.

## Verdict: adopt

Pooled over four seasons, all gameweeks:

| Arm | Brier | ΔBrier | 95% CI | AUC |
|---|---|---|---|---|
| shipped, level from Elo | 0.18158 | — | — | 0.638 |
| **level → fit on n/(n+12)** | **0.18034** | **−0.00123** | **[−0.00219, −0.00047]** | **0.648** |
| level → fit on n/(n+3) | 0.18027 | −0.00130 | [−0.00260, −0.00019] | 0.650 |
| level → fit on n/(n+6) | 0.18027 | −0.00130 | [−0.00244, −0.00036] | 0.649 |
| level → fit on n/(n+20) | 0.18046 | −0.00112 | [−0.00190, −0.00051] | 0.647 |

On the two converged Elo seasons (2024/25, 2025/26), it resolves in **both**
windows — gameweeks 2–5 at −0.00117 [−0.00204, −0.00028] and gameweeks 6–38 at
−0.00160 [−0.00299, −0.00040]. The delta is negative in all four seasons
individually.

**The gain is discrimination, not calibration.** AUC rises 0.638 → 0.648 pooled,
and in every season separately (2022/23 0.610→0.616, 2023/24 0.668→0.682,
2024/25+2025/26 0.641→0.653). That distinguishes it from the exponent and
shrink arms in `results/goals-vs-xg.md`, which left AUC flat at 0.638 and only
moved the spread.

`k` is set to 12 to reuse the team-form blend's constant rather than fit a
second one: 3, 6 and 20 all score within noise of it, so the corpus does not
justify a separate number.

## What it does *not* fix

At gameweek 4, with three matches played, `w = 3/15 = 0.20`. The strength fit
feeding the level is itself 80% prior. Two prior-dominated stages in series mean
the live effect now is small: Chelsea's clean-sheet defence moves 1.102 → 1.100,
5th to 6th of 20, and their goalkeeper's projection moves 3.98 → 3.95 and stays
top of the goalkeeper table.

The structural defect is gone — the rating can now follow a collapse instead of
ignoring it — but it bites in proportion to matches played, so it is a
mid-season correction, not an early-season one. Anyone expecting the gameweek-4
symptom to disappear should read the number above first.

## Caveats

- Realized clean sheets are reconstructed as "opponent scored zero" from summed
  player goals, so own goals are missed.
- Elo ratings are `elo-history.ts`'s walk-forward ratings, not ClubElo's
  published numbers, so this is a verdict about the transformation.
- The gameweek 2–5 window is 80 team-fixtures a season. It resolves pooled, but
  no single season's early window does.
- 2022/23 and 2023/24 are Elo burn-in seasons per the README, and are reported
  for consistency rather than as evaluation.

## Reproducing

```bash
for season in 2022-23 2023-24 2024-25 2025-26; do
  BACKTEST_CASE_OUT=/tmp/lvl-$season.json \
  BACKTEST_DATA_DIR=$BACKTEST_ROOT/$season npx tsx scripts/backtest/cs-level-source.ts
done
npx tsx scripts/backtest/cs-level-source.ts --pool /tmp/lvl-*.json
```
