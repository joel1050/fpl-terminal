# Tier C: combined whole-xP comparison

## Result

The three Tier C changes together lowered held-out whole-xP RMSE in both seasons. On the pooled 49,212 player-gameweeks, RMSE fell from `1.99371` on main to `1.94641` on the candidate branch, a paired delta of `-0.04730` points with a 95% gameweek-cluster interval of `[-0.05879, -0.03619]`. Each season and each position also improved on its own. This supports the combined candidate under the backtest inputs below; it does not establish the same gain with archived historical prices, injury news, or official event-time rosters.

Main is `74ceff274962102b5d774043b29783b22be13d75`; the candidate is `06ad4bf24d70291c0641db9de6cb84b763a88212`. The comparison runs each checkout's production `projectPlayer()`, `buildPlayerSelections()`, and ClubElo FDR functions. Main's source files use the 150-point divisor; the candidate files use 300. The three production-file hashes are recorded with both season outputs under `output/tier-c/combined-*.json`.

## Overall results

Each interval is candidate RMSE minus main RMSE. Negative values favor the combined changes. The paired bootstrap resamples whole gameweeks within each season and keeps each season's gameweek count fixed.

| Held-out season | Player-GWs | Main RMSE | Candidate RMSE | Δ RMSE [95% CI] |
|---|---:|---:|---:|---:|
| 2024/25, GWs 6–38 | 23,575 | 1.99391 | 1.94577 | −0.04813 [−0.06560, −0.03167] |
| 2025/26, GWs 6–38 | 25,637 | 1.99353 | 1.94700 | −0.04652 [−0.06163, −0.03176] |
| Pooled, season-stratified | 49,212 | 1.99371 | 1.94641 | −0.04730 [−0.05879, −0.03619] |

An independent calculation reproduced the paired row set, input identity, pooled sums of squared error, and point RMSEs. Its separate bootstrap seed gave a pooled interval of `[-0.05873, -0.03651]`, which supports the same conclusion.

| Position | Player-GWs | Main RMSE | Candidate RMSE | Δ RMSE [95% CI] |
|---|---:|---:|---:|---:|
| GK | 5,428 | 1.54004 | 1.47815 | −0.06188 [−0.08770, −0.03710] |
| DEF | 16,306 | 2.05952 | 1.99814 | −0.06138 [−0.07829, −0.04570] |
| MID | 22,036 | 1.98454 | 1.95128 | −0.03326 [−0.04849, −0.01843] |
| FWD | 5,442 | 2.21864 | 2.16789 | −0.05075 [−0.07775, −0.02405] |

## Method and coverage

The prediction is one-gameweek xP per player, summed across every fixture in a double gameweek and scored against that player's summed actual FPL points. The model receives no target-week minutes: `projectPlayer()` calculates expected minutes from the production selection output. Every target player-gameweek with an explicit source row is eligible, including rows with zero minutes; blank gameweeks have no player fixture to score. Current club is taken from the player's latest pre-gameweek row, and a target-week club mismatch is excluded so the test doesn't use a future transfer to set the forecast. All fixture rows in a double must be present before that player-gameweek is scored.

Team and player form use only completed gameweeks before the target. Clean-sheet strengths use the same rated Elo proxy, pre-gameweek team strengths, and matches-played counts in both arms. The continuous FDR value comes from each checkout's own production Elo function and is checked against its expected 150- or 300-point divisor. The historical Elo snapshots are synthetic walk-forward ratings from match results, not archived ClubElo. No parameters were refitted for this joint test. These seasons also informed earlier Tier C policy selection, so this comparison confirms the combined result on reused historical data rather than a new untouched holdout.

| Season | Source player-fixture rows | Explicit zero-minute rows | Scored player-GWs | Scored zero-minute GWs | Excluded cold starts | Excluded position/team/coverage rows |
|---|---:|---:|---:|---:|---:|---:|
| 2024/25 | 24,394 | 14,364 | 23,575 | 13,708 | 123 | 322 |
| 2025/26 | 26,159 | 16,190 | 25,637 | 15,824 | 100 | 13 |

The source corpus had 10 identical duplicate rows in 2025/26; the harness removed those before constructing fixtures and rejected any conflicting duplicate. It scored 33 gameweeks and all 20 rated clean-sheet strengths per season. The candidate and main runs used identical prepared input hashes and identical player-gameweek keys, outcomes, minutes, and fixture counts; the summary script asserts those pairings.

## Limits

The prepared corpus lacks historical market prices, injury/status snapshots, and predicted lineups. The harness supplies a common £5.0m price to every player so the price-tier prior is generic in both arms, sets availability to `a`, and supplies no news evidence. Those shared assumptions keep the comparison paired but can change the size of the result, especially for the start-probability change. Fixture pairings and gameweek placements use the final historical schedule, which may differ from what was known before later rescheduling. Rows represent the archive's player coverage rather than a complete event-time FPL element list; missing rows are not imputed as DNPs. Cold starts, unsupported historical positions, target-team changes since the last observed fixture, and incomplete fixture rows are excluded. The result is evidence that the three edits improve xP RMSE on these matched historical records under common priors, not a test with full historical live inputs.

## Reproduction

Use the prepared season inputs and the gameweek-opening Elo files in `/tmp/fpl-tier-c-elo-corrected-20261008`. The main snapshot needs the same experiment script and its two shared data helpers so both checkouts run an identical harness; the production modules remain from each revision.

```sh
mkdir -p /tmp/fpl-tier-c-main-74ceff2-combined-20261008
git archive 74ceff274962102b5d774043b29783b22be13d75 \
  | tar -x -C /tmp/fpl-tier-c-main-74ceff2-combined-20261008
ln -s "$(pwd)/node_modules" /tmp/fpl-tier-c-main-74ceff2-combined-20261008/node_modules
cp scripts/backtest/season.ts scripts/backtest/multiSeasonData.ts \
  scripts/backtest/tier-c-combined.ts /tmp/fpl-tier-c-main-74ceff2-combined-20261008/scripts/backtest/

for season in 2024-25 2025-26; do
  (cd /tmp/fpl-tier-c-main-74ceff2-combined-20261008 && \
    TMPDIR=/tmp BACKTEST_DATA_DIR=/tmp/fpl-tier-c-elo-corrected-20261008/$season \
    TIER_C_ARM=main TIER_C_SOURCE_REF=74ceff274962102b5d774043b29783b22be13d75 \
    TIER_C_OUTPUT_DIR=/tmp/fpl-tier-c-combined-output \
    node --import tsx scripts/backtest/tier-c-combined.ts run)
  TMPDIR=/tmp BACKTEST_DATA_DIR=/tmp/fpl-tier-c-elo-corrected-20261008/$season \
    TIER_C_ARM=candidate TIER_C_SOURCE_REF=06ad4bf24d70291c0641db9de6cb84b763a88212 \
    TIER_C_OUTPUT_DIR=/tmp/fpl-tier-c-combined-output \
    node --import tsx scripts/backtest/tier-c-combined.ts run
done

TMPDIR=/tmp BACKTEST_DATA_DIR=/tmp/fpl-tier-c-elo-corrected-20261008/2024-25 \
  TIER_C_ARM=main TIER_C_OUTPUT_DIR=/tmp/fpl-tier-c-combined-output \
  node --import tsx scripts/backtest/tier-c-combined.ts summarize
```

TypeScript and focused ESLint pass for the harness. The paired season outputs, summary metrics, input hashes, coverage, and source hashes are in `output/tier-c/` for this run.
