# Experiment: ClubElo attack and defence multipliers

## Assignment

Conduct a reproducible historical experiment to find whether fitted attack and goals-conceded multipliers improve the current FPL projection model. Compare the existing continuous difficulty mapping with fitted difficulty curves and a model that reads historical ClubElo ratings directly. Deliver measured results and an implementation recommendation; do not change production behaviour as part of this assignment.

“Optimal” means the best candidate selected before final evaluation. Do not describe the best fit to the complete dataset as an optimal forecasting model.

Follow the repository's `AGENTS.md`. Read the relevant sections of `calculations.md`, especially §§2.2–2.2.1, 3, 6.3.2, 7 and 8. Inspect current source rather than treating published backtest numbers as the baseline. Preserve unrelated changes and other agents' experiment files.

## Files and existing infrastructure

Start with:

- `lib/clubElo.ts`: continuous difficulty and club identities.
- `lib/projections/fixtureAdjustment.ts`: attacking multipliers, goals conceded and clean-sheet probabilities.
- `lib/projections/cleanSheetStrength.ts`: Elo level, attacking/defensive lean and their in-season blend.
- `lib/historical/inSeasonForm.ts`: pre-gameweek team-strength fitting.
- `lib/projections/projectPlayer.ts`: scenario-weighted player xP.
- `scripts/backtest/season.ts`, `historicalBacktest.ts`, `multiSeasonData.ts`: historical inputs and safeguards.
- `scripts/backtest/clubelo-history.ts` and `results/clubelo-history.json`: actual dated ratings and fixture dates.
- `scripts/backtest/tier-c-combined.ts`: production projection replay.
- `scripts/backtest/multiplier-calibration.ts`: earlier diagnostics, which may use proxy ratings and require adaptation.

Prepared seasons currently exist under `/tmp/fpl-tier-c-elo-corrected-20261008/`. Treat this as a configurable input path, not a dependency guaranteed on another machine. Rebuild missing inputs through existing preparation tools. Never hand-edit generated data or snapshots.

Own these new files, plus uniquely prefixed helpers if required:

```text
scripts/backtest/attackdefensemult-testing.ts
scripts/backtest/results/attackdefensemult-testing.md
scripts/backtest/results/attackdefensemult-testing.json
tests/core/attackdefensemult-testing.test.ts
output/attackdefensemult-testing/
```

Keep large prediction files and temporary variants under `output/` or an isolated `/tmp` checkout. Do not modify shared production functions to expose experimental parameters unless explicitly authorized. A temporary source variant must retain the original baseline and record exactly which experimental expressions changed.

## 1. Freeze the protocol and baseline

Before evaluating candidates, save a protocol containing the source revision and relevant source hashes, input hashes, model families, parameter bounds, fitting objective, chronological splits, candidate-selection rule, metrics, bootstrap seed and acceptance criteria. Record the dirty-tree state as well as the revision, since a commit identifier does not identify uncommitted source.

Reproduce the current attacking and rated clean-sheet paths through production code. Current values to verify include:

```text
continuous difficulty = clamp(3 + (opponentElo - ownElo) / 300, 1, 5)
attack difficulty anchors = [1.14, 1.07, 1.00, 0.92, 0.84]
attack ratio clamp = [0.70, 1.35]
final attack multiplier clamp = [0.55, 1.60]
home/away attacking factors = 1.102 / 0.898
rated clean-sheet dispersion = 12
```

Also verify the current Elo-level slope, skew retention and level-prior match weight. The defence path uses rated attack/defence strengths rather than the attacking difficulty table. Its current additional difficulty multiplier is therefore **1**, not the reciprocal of the attacking multiplier.

Use assertions to verify baseline parity on the rated path, including schedule-adjusted player form, expected minutes and double gameweeks. The generic `validate.ts` parity gate alone may exercise a different fallback path. Fail visibly if baseline reproduction is unresolved.

## 2. Construct forecast-time observations

Build two team-perspective rows per fixture with season, gameweek, fixture ID, club identities, venue, kickoff date, own/opponent Elo, rating dates and lags, pre-gameweek team strengths, rated clean-sheet strengths, actual team xG, opponent xG, goals and clean-sheet outcome.

Freeze all clubs' ratings and completed-gameweek inputs before the first kickoff of each target gameweek, matching the intended pre-deadline forecast. ClubElo chart values on an event date are post-match: select a rating **strictly earlier than the cutoff date**. Do not substitute the current snapshot or result-derived Elo proxies for missing history. Report missing coverage and stale-rating lags. Use a prespecified sensitivity analysis for ratings more than 30 days old, without changing the primary cohort after inspecting results.

Deduplicate exact repeated fixture/player rows and reject conflicting copies. Never estimate team xG by summing duplicated player-fixture records. Keep both sides of a fixture in the same split and bootstrap cluster. Scoring attacking and conceding predictions against the same xG observation does not create two independent observations.

Preseason priors must use prior seasons, and current form must use only earlier completed gameweeks. Historical final schedules are not necessarily archived deadline schedules; record that limitation. A player's absent archive record is unknown, not an invented DNP. Preserve explicit zero-minute outcomes and sum every recorded fixture in double gameweeks for player-xP evaluation.

## 3. Candidate models

### A. Current production control

Run the unchanged formulas with actual historical ClubElo inputs. Hold the player model, availability reconstruction, prices, team-strength decay/prior, venue, league means, distribution assumptions and clamps fixed across the primary arms. This isolates the multiplier changes from the other Tier B experiments.

### B. Fitted continuous difficulty curves

Use the existing continuous difficulty input and fit separate monotonic piecewise-linear functions over knots 1, 2, 3, 4 and 5:

```text
M_attack = f_A(difficulty) * attackingVenue
           * clamp(ownAttack / opponentDefence, 0.70, 1.35)^gamma_A

lambda_conceded = leagueMeanXG * opponentVenue * f_C(difficulty)
                  * (ratedOpponentAttack / ratedOwnDefence)^gamma_C
```

Anchor `f_A(3) = f_C(3) = 1`. Require `f_A` to decrease with difficulty and `f_C` to increase. A higher `f_C` means more goals conceded, not stronger defence. Permit a flat curve, including `f_C = 1`, so the experiment can conclude that an additional Elo-gap adjustment is redundant.

Jointly fit curve parameters and the two nonnegative ratio exponents. Regularize toward the current attacking curve, `f_C = 1` and exponents of 1. Use a small prespecified regularization grid rather than a large unrestricted sweep. Keep the Elo divisor at 300: fitting it alongside free curve slopes creates overlapping parameterizations. Apply the final attack clamp exactly as production does.

### C. Raw ClubElo model

Test whether separate own and opponent ratings carry information that their difference loses. Standardize ratings as `(Elo - referenceElo) / 100`, using a reference fixed from the fitting data. Fit a small log-linear model, with separate attacking and conceding equations:

```text
log(M_attack) = a_own * ownEloScaled - a_opp * opponentEloScaled
               + a_ratio * log(clampedAttackRatio) + log(attackingVenue)

log(lambda_conceded / leagueMeanXG)
             = c_opp * opponentEloScaled - c_own * ownEloScaled
               + c_ratio * log(ratedConcedingRatio) + log(opponentVenue)
```

Constrain Elo coefficients to nonnegative values and regularize them, since Elo and team-strength ratios overlap. Fit normalization on fitting data only and document what makes a multiplier neutral. Do not add gap-based difficulty as another free feature: it is derived from these same ratings. Include a gap-only restriction and an Elo-only restriction as diagnostics, without using final outcomes to choose between them.

Leave the existing Elo-levelled clean-sheet strengths fixed in this first experiment. If raw Elo adds no benefit after those strengths are supplied, that is a valid result. Removing/replacing their Elo term or retuning its slope is a separate, clearly labelled ablation, not an unnoticed change to the baseline.

For both candidate families, convert the fitted conceding mean to clean-sheet probability using the same production negative-binomial dispersion and probability bounds. Pass the mean and probability through the existing xP calculation consistently. Do not replace a negative-binomial mean with `-log(P(clean sheet))`, which is a Poisson-only relationship. Keep goals-conceded scoring and other distribution choices unchanged so their effects remain attributable.

## 4. Fit, select, then evaluate once

Use this chronological split if coverage permits:

```text
2023/24: fit parameters
2024/25: select regularization and one primary candidate
2025/26: frozen final evaluation
```

Fit attack curves against team xG and conceding curves against opponent xG, using an explicitly stated raw-scale objective that accepts zero xG. Do not turn zero xG into an arbitrary positive floor and then claim to have minimized ordinary xG RMSE. A log-link quasi-Poisson objective is acceptable, but state that it is not an integer likelihood for fractional xG.

Before final evaluation, select candidates using team-xG accuracy, then production player-xP validation and clean-sheet calibration. Prespecify the ordering and any non-inferiority tolerances; do not invent tolerances after inspecting final-season results. Freeze parameters, model family, normalization and clamps before opening final metrics. Report other frozen families as secondary comparisons, not as alternative winners selected using final outcomes.

These seasons have already informed earlier model development. Call this reused historical validation, not a pristine holdout. Recommend a later prospective season as confirmation. If fitting coverage requires different splits, justify and freeze the change before candidate scoring.

## 5. Metrics and uncertainty

Report baseline, candidate, `candidate - baseline`, relative change and matched observation count for:

- Team attacking-xG RMSE and conceded-xG RMSE, separately.
- Goals-conceded count RMSE and clean-sheet Brier score against actual goals.
- Integrated player-gameweek total-xP RMSE, MAE and signed mean bias.
- The relevant player-xP components, to explain any integrated improvement or regression.

Do not equate team-xG or minutes accuracy with total-xP accuracy. Run player projections through the actual scenario/fixture pipeline rather than multiplying the final xP total by a fixture scalar. Preserve schedule adjustment: player historical rates already carry team/fixture effects, and a new multiplier must not count them twice.

Evaluate every arm on identical eligible observations. Report full coverage and an ex-ante forecast-starter slice, without choosing membership from realized minutes. Historical price/status/lineup reconstruction must stay identical in every arm and remain explicit in the report.

Calculate paired 95% bootstrap intervals by resampling whole season-gameweek clusters, retaining both fixture sides and all associated player rows. Stratify by season for pooled secondary analyses. Use a fixed seed and at least 5,000 draws. Intervals conditional on fitted parameters do not include parameter-estimation uncertainty; say so. Do not reselect candidates inside final bootstrap draws.

Produce calibration plots/tables by continuous Elo-gap band, home/away venue, and own/opponent Elo level. Examine strong-versus-strong and weak-versus-weak fixtures separately because gap-based difficulty gives them the same value. Include multiplier curves, row counts, clamp-binding frequency and sparse-band warnings. Give results for GW1–5 separately from later gameweeks, without refitting on either slice.

## 6. Acceptance and required delivery

Recommend **implement** only when the frozen candidate resolves an improvement on its relevant final accuracy metric, passes the prespecified integrated-xP and clean-sheet non-inferiority checks, and has no unresolved leakage or parity issue. Improving team xG alone supports the mapping's signal; it does not establish an FPL-xP gain. A confidence interval that crosses zero means inconclusive, not proven equivalent. If candidates are indistinguishable, retain the simpler/current formula.

For a defence-only change, clean-sheet calibration and conceded-goal scoring must support the verdict. For an attack-only change, attacking components and total xP must support it. Use **do not implement** for supported deterioration and **inconclusive** for unresolved gains, insufficient coverage or missing integration evidence.

Add focused tests/self-checks for strictly prior rating lookup, zero-xG handling, curve anchoring and monotonicity, no-op candidate parity, duplicate detection, double-gameweek aggregation, and deterministic paired metrics. Run the focused tests and required repository checks. Report existing or environment-related failures accurately; do not weaken assertions or change unrelated code to make checks pass.

Deliver the executable experiment, a JSON report, a concise Markdown report, fitted parameter files, curve/calibration artifacts and exact reproduction commands. Include source/input hashes, fit/selection/final coverage, every prespecified arm, final paired intervals, data limits, and one implementation verdict. The final user summary must distinguish what improved from what was not established. Leave production formulas unchanged unless the user subsequently asks to implement the supported candidate.
