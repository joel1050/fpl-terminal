# Projection backtests

Walk-forward tests of the projection model. Everything a projection sees at
gameweek `t` comes from gameweeks before `t`.

## Remeasurement after production-parity repair — 2026-09-09

This is the authoritative result set after the harness fixes in `fa8f4ca` and
`316d270`. `expectedPoints(...)` now matches `projectPlayer(...)` component by
component, including price-tiered historical xG, team-normalized fallback
priors, and fixture-scaled bonus. `tests/core/backtest-parity.test.ts` covers GK,
DEF, MID and FWD cases with and without historical/form evidence, plus an easy
versus hard fixture bonus check. Reverting the historical xG fix breaks the
DEF/MID goal assertions; reverting fixture scaling breaks every parity case and
the bonus direction test.

Prepared inputs came from `prepare-seasons.ts`, followed by `elo-history.ts`.
The validation gate reproduces production exactly on the legacy 2025/26 corpus
(9,972 played rows) and on all four prepared corpora: 2022/23 9,872, 2023/24
9,905, 2024/25 10,030, and 2025/26 9,972. The paired intervals below resample
gameweek clusters. An arm delta is arm RMSE minus shipped RMSE, so negative is
better.

For a clean rerun, keep the prepared inputs in a scratch root rather than
`data/generated`, then run each season in its own process because
`BACKTEST_DATA_DIR` is read at module import:

```bash
BACKTEST_ROOT=$(mktemp -d)
BACKTEST_MULTI_DATA_DIR=$BACKTEST_ROOT npx tsx scripts/backtest/prepare-seasons.ts
BACKTEST_MULTI_DATA_DIR=$BACKTEST_ROOT npx tsx scripts/backtest/elo-history.ts
for season in 2022-23 2023-24 2024-25 2025-26; do
  BACKTEST_DATA_DIR=$BACKTEST_ROOT/$season npx tsx scripts/backtest/validate.ts
done
```

Run the remaining scripts the same way by replacing `validate.ts`; the
prepared root already contains the walk-forward `backtest-elo.json` and
`fixture-difficulty.json` inputs produced by `elo-history.ts`.

FPL published no xG before gameweek 16 of 2022/23. Treat that season as a
reduced replication for fixture and xP checks and do not use its form or
conversion result to choose a constant. The Elo model also uses 2022/23 and
2023/24 as burn-in; its evaluation seasons are 2024/25 and 2025/26.

### Remeasured scripts and corpora

| Script | Corpus | Status |
|---|---|---|
| `validate.ts` | legacy 2025/26 plus prepared 2022/23–2025/26 | Exact parity on every played row. |
| `team-level.ts`, `elo-strength-arms.ts` | prepared 2022/23–2025/26 | Remeasured; only 2024/25 and 2025/26 count as converged Elo evaluation. |
| `fit-conversions.ts` | prepared 2022/23–2025/26 | Remeasured; 2022/23 is incomplete and excluded from constant selection. |
| `run.ts`, `fwd-swing.ts`, `bias.ts`, `players.ts` | prepared 2022/23–2025/26 | Remeasured; 2022/23 retains the xG caveat. |
| `form-weight.ts` | prepared 2023/24–2025/26, anchor GWs 1–12 and 1–19 | Remeasured. The 2022/23 1–12 split has zero usable rows and its later split is not comparable. |
| `evidence-weights.ts` | prepared 2023/24–2025/26, anchor GWs 1–12 and 1–19 | Remeasured with 2,000 clustered bootstrap samples per run. |

Every other backtest verdict later in this file is a historical result and is
**unverified after the parity repair**. In particular, `cleansheets.ts`,
`sweep.ts`, `anchor.ts`, `position.ts`, `cs-tiers.ts`, `cs-fit.ts`,
`reliability.ts`, `schedule-adjust.ts`, `fdr.ts`, and `elo-fdr.ts` were not
rerun in this pass.

### Current verdicts

| Question | Remeasured verdict |
|---|---|
| Widen the team-strength level | **Reject.** On converged seasons, level 1.35 costs +0.0090 RMSE in 2024/25 and +0.0101 in 2025/26, with both intervals above zero; 1.69 and 2.0 are worse again. |
| Add Elo to the widened team-strength level | **Reject.** Every `team-level.ts` level-1.69-plus-Elo arm is worse on both evaluation seasons. |
| Add Elo at the shipped strength level | **Unresolved.** In `elo-strength-arms.ts`, measured-slope Elo is +0.00459 in 2024/25 and +0.01334 in 2025/26, while an Elo level matched to the shipped spread is -0.00292 and -0.00046; all four intervals cross zero. This disagrees with the broad old “Elo rejected” wording because `team-level.ts` tests Elo only after widening the level. The scripts also build their fixture base differently, so their shipped xG baselines differ (2025/26 0.7422 versus 0.74018). |
| Remove the opening clamps | **Reject.** The no-clamp arm costs +0.0097 [-0.0070, +0.0252] in 2024/25 and +0.0122 [+0.0035, +0.0212] in 2025/26. |
| Drop the Elo/FDR base | **Unresolved.** The direction changes by season and the shipped-level intervals cross zero. |
| Let bonus follow the attacking fixture | **Keep, with a position caveat.** Making bonus flat is worse for GK/DEF in 2022/23 (+0.0053 [+0.0020, +0.0092]) and 2025/26 (+0.0040 [+0.0008, +0.0071]), but better for MID/FWD in 2024/25 (-0.0060 [-0.0112, -0.0018]) and 2025/26 (-0.0042 [-0.0078, -0.0006]). The old claim of a universal gain has flipped for recent attackers. |
| Restore the old outer clamp `[0.70, 1.30]` | **Mixed; keep shipped.** It is worse overall in 2022/23 (+0.0046, resolved), better in 2024/25 (-0.0064, resolved), and unresolved in the other seasons. The separate team-level test still rejects removing clamps entirely. |
| Widen the attack-ratio clamp to `[0.55, 1.75]` | **No general gain.** Overall intervals cross zero in all four seasons; only the 2025/26 GK/DEF slice resolves in its favour. |
| Change defensive-contribution dispersion | **No stable constant.** The near-Poisson arm improves 2023/24 and 2024/25, reverses and worsens in 2025/26, and is unresolved in 2022/23. This flips the old “8 is the optimum and Poisson is worst” verdict. |
| Scale defensive contributions with opponent attack | **Reject.** It is significantly worse in 2023/24 and 2024/25 and unresolved, not better, in the other two seasons. |
| Make GK/DEF bonus follow clean-sheet conditions | **Reject.** Both defensive bonus arms are worse in 2022/23 and 2025/26 and unresolved in 2023/24 and 2024/25. |
| Extrapolate the clean-sheet table | **Reject.** It is worse in 2022/23 and 2025/26 and unresolved in the middle seasons. Bilinear interpolation does not change these integer-tier rows. |
| Widen forward fixture swing further | **Reject.** Shipped swing matches observed swing only in reduced 2022/23; it is already too steep for all forwards in 2023/24, 2024/25, and 2025/26. The old “forward swing is too flat” verdict has flipped. |
| Change the shipped form decay/prior weight from `0.95 / 6` | **No.** In-season form beats anchor-only in all six usable season/anchor runs, but no alternative prior at the shipped decay has an interval excluding zero. The selected surfaces also disagree by season and anchor length. |
| Use reliability weights for starts and minutes | **Start model supported; minutes model unresolved.** Start Brier improves in all six runs, with every interval below zero. Minutes RMSE improves directionally in all six, but every interval crosses zero. Holding rates fixed, the minutes arm improves xP on all three 12-GW anchors and narrowly on the 2025/26 19-GW anchor; the other two 19-GW xP intervals cross zero. Historical RotoWire inputs remain unavailable, so this tests the fallback role model only. |
| Replace the shipped rate blend with direct reliability weights | **Do not ship.** Equal/metric rate arms are mixed or worse. A selected 20/current-to-1/previous arm improves xP on all three 12-GW splits, but not on the 19-GW splits; it is an exploratory minimum from a sweep, not a replicated constant. |
| Infer a stable section-8 bias or team-tier correction | **No.** Overall appearance bias is -0.295, +0.038, +0.071, and -0.258 across 2022/23–2025/26, and the anchored team-tier slices in `players.ts` do not show a stable monotone gradient. These scripts are descriptive and do not support a constant change. |

### Goal and assist conversion fits

The table reports out-of-fold bias-neutral scalars as goal/assist by position,
then the whole-model RMSE delta against no conversion. The only resolved gain
is the incomplete 2022/23 season. The three usable seasons disagree on most
directions and every whole-model interval crosses zero, so production constants
remain unchanged.

| Season | DEF | MID | FWD | RMSE delta [95% CI] | Decision |
|---|---:|---:|---:|---:|---|
| 2022/23 reduced | 1.109 / 1.349 | 1.467 / 2.009 | 1.332 / 3.486 | -0.0179 [-0.0348, -0.0010] | Exclude: xG begins at GW16. |
| 2023/24 | 1.108 / 1.184 | 1.011 / 1.332 | 1.021 / 2.051 | +0.0031 [-0.0041, +0.0102] | Unresolved. |
| 2024/25 | 0.818 / 1.121 | 0.888 / 1.261 | 1.010 / 1.531 | -0.0006 [-0.0044, +0.0028] | Unresolved. |
| 2025/26 | 0.818 / 1.272 | 0.871 / 1.201 | 0.973 / 2.584 | +0.0006 [-0.0050, +0.0060] | Unresolved. |

```bash
npx tsx scripts/backtest/validate.ts      # gate: harness must reproduce projectPlayer()
npx tsx scripts/backtest/run.ts           # section 7 variants scored on section 8 xP
npx tsx scripts/backtest/cleansheets.ts   # the clean-sheet model scored directly
npx tsx scripts/backtest/sweep.ts         # clamp-width sweep and team-goals test
npx tsx scripts/backtest/bias.ts          # where section 8 is systematically high or low
npx tsx scripts/backtest/players.ts       # per-player xP, and bias by team strength tier
npx tsx scripts/backtest/cs-tiers.ts      # clean-sheet calibration per defence tier
npx tsx scripts/backtest/cs-fit.ts        # fits a table correction, checks it out of sample
npx tsx scripts/backtest/form-weight.ts   # form decay, anchor weight, and the current-season share
npx tsx scripts/backtest/reliability.ts   # how many appearances each stat needs to mean anything
npx tsx scripts/backtest/evidence-weights.ts  # turns those reliabilities into walk-forward weighting rules
BACKTEST_DATA_DIR=... npx tsx scripts/backtest/schedule-adjust.ts 2024-25  # schedule-adjusting a player's own form
```

`season.ts` reads `BACKTEST_DATA_DIR` once at import, so prepare each season in
its own scratch directory (never `data/generated`) and loop in the shell:

```bash
for s in 2022-23 2023-24 2024-25 2025-26; do
  BACKTEST_DATA_DIR=$SCRATCH/$s npx tsx scripts/backtest/schedule-adjust.ts $s
done
```

The gate exists because when it passes, an arm difference is a model difference
and not a harness difference. Run it before any xP script.

---

Everything below this divider is the pre-repair research record. Preserve it as
context, but treat every verdict as **unverified after the parity repair** unless
the 2026-09-09 tables above explicitly remeasure it. Where the two disagree, the
remeasurement wins.

## Method

- Minutes are the actual minutes played. The minutes model contributes far more
  error than anything in section 7 and would bury the signal. Absolute errors
  are therefore better than a live model achieves; only the *differences*
  between arms are results.
- Significance is a paired bootstrap over **gameweek clusters**, not rows. Rows
  in one fixture share a lambda and a team, so row-level resampling would
  understate the standard error.
- Two inputs are held constant across arms because only season aggregates exist
  for them (saves and defensive contributions per 90). They cancel in a paired
  comparison, except for the saves arm, whose claim is limited accordingly.

## Findings

| Change | Verdict |
|---|---|
| Widen the `[0.78, 1.22]` attack-ratio clamp to `[0.70, 1.35]` | **Adopt.** RMSE −0.0008, CI excludes zero, better in 24/33 gameweeks. The gain saturates at `[0.70, 1.35]` and is flat all the way to unclamped, which is what truncated signal looks like. Stop at `[0.70, 1.35]`: `blendInSeasonForm` floors defence at 0.05, so an unclamped ratio can reach ~25. |
| Venue `1.102 / 0.898` instead of `1.03 / 0.97` | **Adopt as a correctness fix.** Measured over all 380 fixtures. Directionally better on every slice and on team goals; never individually significant in one season. |
| Delete `defenceMultiplier`, `overallMultiplier`, `fixtureMultiplier`, `adjustFixture` | **Adopt.** Verified: no consumers anywhere in `lib/`, `app/`, `components/`, `store/` or `tests/`. |
| Widen or remove the outer `[0.7, 1.3]` multiplier clamp | **Reject — and note it is load-bearing.** It does not bind in the backtest only because FDR is neutralized there. In production (`base` up to 1.07) it binds on 8.9% of fixtures at baseline, and on 14–20% once the venue term rises. Widening it to `[0.6, 1.5]` made the recommended arm *worse* (−0.0013 vs −0.0018). Leave it alone. |
| Replace the 5×5 clean-sheet table with a Poisson | **Reject.** Brier +0.0001 (ns) on the direct test; significantly *worse* for MID/FWD on xP. Tested across three scales and three exponents; none beat the table. |
| Read the same table by bilinear interpolation | **No gain.** Brier −0.0001 (ns). The tier snap is ugly but costs nothing measurable. |
| Scale goalkeeper saves off opponent attack | **No gain.** ns on 666 GK rows. |
| Correct the bottom rows of the clean-sheet table | **Reject.** Every correction tried improves in-sample and gets *worse* under 5-fold cross-validation: scaling the tier-1 row 0.18366 in-sample against 0.18410 held out, a global logit recalibration worse in 5 folds out of 5. Tier-1 defences appear in only 59 team-fixtures, and the tier-1 miss of +0.063 has a confidence interval of [-0.027, +0.144]. |
| Drop FPL difficulty when strengths exist | **Untestable here.** No FDR exists for 2025/26. In the 2026/27 snapshot home FDR only ever takes 2, 3 or 4, so `base` spans 1.07–0.92, not 1.14–0.84. |

## Counting the right unit

A defender's expected points and his team's clean sheet are the same event. One
team-fixture carries about 9.8 defender rows, so scoring per player row and
treating those as independent overstates the evidence by roughly `sqrt(9.8)`, or
3.1x. That is the difference between the tier-1 defender bias reading
`+0.388 [0.136, 0.595]` - apparently real - and `+0.388 [-0.401, 1.035]`, which
is no finding at all. Cluster by fixture, or count per team-fixture, before
calling anything a defect.

## Later changes

| Change | Verdict |
|---|---|
| Cards (yellow -1, red -3) | **Adopt.** Overall bias +0.174 → **+0.045** per appearance; started midfielders +0.175 → +0.001. Rates measured from every 2025/26 appearance, and differential: DEF -0.165, FWD -0.088. `anchor.ts` |
| Bonus follows the fixture | **Adopt.** RMSE -0.0033 for GK/DEF, interval excluding zero. Closes most of the forward fixture swing (0.73 → 1.01 against an observed 1.07). `run.ts`, `fwd-swing.ts` |
| Outer multiplier clamp 0.7–1.3 → 0.55–1.6 | **Adopt on calibration, not accuracy.** RMSE unchanged (+0.0006, ns). But it bound on 14% of forward-fixtures and pinned 11 of Haaland's 30 onto one ceiling. `fwd-swing.ts` |
| RotoWire precedence over correlated FPL flags | **Not backtestable** — no RotoWire archive for a past season. Held by `tests/data/rotowire-precedence.test.ts`. |
| Defensive contributions rise against a stronger attack | **Reject.** The plausible mechanism is real and the term still gets worse: DEF xP RMSE +0.0078 at half strength and **+0.0258 at full, interval excluding zero**. `run.ts` |
| Re-tuning the defensive-contribution dispersion | **Reject, keep 8.** Swept 3, 5, 12, 20 and 1000: every value is inside the noise and the Poisson end (1000) is the worst of them. The assumed 8 sits at the optimum. `run.ts` |
| Defender bonus following the clean sheet instead of the attack | **Reject.** +0.0015 following the clean sheet, +0.0008 following both, neither resolving. The mechanism story favours the defensive side; the measurement does not, so the shipped attacking multiplier stays. `run.ts` |
| Scaling down the weak end of the clean-sheet table | **Reject.** Fitting a scale on the tier-1 rows helps in-sample (0.18403 → 0.18366) and **hurts out of sample** (0.18410), improving 3 folds of 5. Per team-fixture the tier-1 miss is +0.063 [-0.027, 0.144] and the tier-1 defender bias +0.185 [-0.610, 0.820]. `cs-fit.ts`, `cs-tiers.ts` |
| Rescale the team-strength level onto the goal scale | **Reject.** Section 3's strengths are ratios, so the level cancels in every consumer and has never had to be right; it is 1.7x narrower than a Poisson fit on the same xG. Fixing it is monotonically worse on team xG: +0.0100 at 1.35x, +0.0186 at 1.69x, +0.0241 at 2.0x, every interval excluding zero, while clean-sheet Brier moves less than the corpus resolves. `team-level.ts` |
| Take part of the team-strength level from Elo | **Reject.** Worse on team xG at every weight from 0.25 to 1.0 (+0.0183 to +0.0242). Best clean-sheet Brier is 0.18195 at weight 0.5 against 0.18237 for the level as is - well inside the noise. `team-level.ts` |
| Remove the §7.2 clamps | **Reject, and they are more load-bearing than before.** Opening both windows costs +0.0121 team-xG RMSE, interval excluding zero; on a widened level it costs +0.1283. They bite on 16.4% of team-fixtures as shipped. `team-level.ts` |
| Drop the Elo-gap `base` once the strength ratio carries the fixture | **Unresolved, and the only live lead here.** -0.0038 team-xG RMSE on the shipped level with the interval spanning zero. It reverses sign on a widened level (+0.0081, excluding zero), so it is a claim about the shipped scale only. `team-level.ts` |
| Interpolating the clean-sheet table | **Reject.** Reading the same 5×5 table continuously rather than snapping to a cell: Brier -0.0001 on the event itself and xP RMSE **+0.0019 for GK/DEF**, both intervals spanning zero. Extrapolating past the grid as well is directionally better but cannot be resolved: [-0.0201, +0.0141]. `cleansheets.ts`, `run.ts` |

| Lower `PLAYER_FORM_PRIOR_WEIGHT_MATCHES` so recent form counts for more | **Reject — the evidence points the other way.** Swept decay 0.80-1.00 against prior weight 0-48 and both null arms. The aggregate optimum is 32 against a 7.1-match anchor and 48+ against a 10.8-match anchor, both above the shipped 24, and the optimum rises as the anchor improves. Production's anchor is a full 38-match season, longer than either split, so the trend argues for *less* form weight, not more. Gains are tiny either way (held-out RATE RMSE -0.0010 and -0.0023; xP RMSE 2.7572 -> 2.7557). `form-weight.ts` |
| Weight form more for players whose form diverges from their anchor | **It depends on the anchor, and that is the finding.** In the widest divergence quartile the optimum is ~16 against a 7.1-match anchor (anchor-only is clearly worse, 0.3565 vs 0.3784) but 48 against a 10.8-match anchor (0.3403, with anchor-only 0.3432 beating the shipped 24). A short anchor deserves less trust; a long one deserves more. Nothing here is a fixed constant. `form-weight.ts` |
| The fixed anchor weight is biased for players whose level genuinely changed | **Confirmed.** Scored against each player's *actual rest-of-season* rate, one row per player. A divergence is about half real: risers' future landed 57% of the way from anchor to form, fallers' 50%, and 57% of players moved by more than 1.5x in a season. At the shipped weight risers are under-projected by 0.054 xGI/90 and fallers over-projected by 0.059 - roughly half a point a match for a forward. Prefer the FELL group when the two disagree: a 1.5x threshold is easier to cross from a low anchor, so RISE is the noisier half by construction. `form-weight.ts` |
| Winsorise the form estimate before blending it | **Adopt - the largest single gain measured anywhere in this suite.** Capping the form/anchor ratio at 2.5x in either direction takes pooled RMSE against the rest-of-season rate from 0.1908 to 0.1546 on all players and 0.2196 to 0.1644 on movers, holding the share fixed. A handful of extreme divergences dominate a sum of squares and revert hardest, which is why an unwinsorised fit puts the optimal current-season share near 5% while the same fit with the top 5% of divergences trimmed puts it at 25-81% and rising. Both numbers are real; the second is the one that describes a typical player. `form-weight.ts` |
| Let the current season's share rise with matches played, `s = n / (n + k)` | **Adopt on top of winsorising.** k fitted to the trimmed shares is 8.5 against a 7.1-match anchor and 12.0 against a 10.8-match anchor - a ratio of 1.20 and 1.11, i.e. very close to weighting each season by its own match count. Winsorised form with `n/(n+9)` scores 0.1504 / 0.1604 against 0.1546 / 0.1644 for winsorised form at the shipped share. Extrapolating the ratio to production's 38-match anchor gives k ~ 44: 19% at ten matches, 31% at twenty, 46% at thirty-seven. That is a 3.5x extrapolation from two points - measure it directly before shipping a constant. `form-weight.ts` |
| Ramp the current season's share linearly to 100% by gameweek 38 | **Directionally right, beaten by `n/(n+k)`.** Winsorised, it scores 0.1532 against 0.1504 for the fitted curve, and unwinsorised it is worse than the shipped blend (0.2092 against 0.1908). Reaching 100% throws away a full previous season of real evidence at exactly the point the current season has only drawn level with it. `form-weight.ts` |
| ~~The movers' optimal anchor weight falls from 48 to 8 as evidence accumulates~~ | **Retracted.** The earlier `evidenceScaling` pass bucketed players by the *length of the observation window* rather than by matches they actually played, so a player with three appearances sat in the "sixteen matches" row. Bucketing by real match count removes the trend. The bias results in the row above are unaffected - they are measured at a fixed weight, not fitted. |
| Within a season a player's *rate* barely drifts; their *minutes* drift a lot | **Measured, and it corroborates the row above.** Split-half reliability (odd against even appearances, Spearman-Brown lifted) versus forward correlation, disattenuated for the future window's own noise. Underlying stability is 0.92-1.00 for xG/90, xGI/90 and xA/90 - no detectable change of level - against 0.68-0.74 for minutes per gameweek and start rate. So the anchor-versus-form argument is about the wrong quantity for rates and the right one for availability. `reliability.ts` |
| Matches of noise carried by one appearance, `k` in `r = n/(n+k)` | **0.7** minutes, **1.2** start rate, **2.0** xG/90 and xGI/90, **4.5** xA/90, **9** goals+assists per 90, **10.5** FPL points per match, **25** FPL points per 90. Reliability crosses 0.5 at `n = k` and 0.7 at `n = 2.3k`: two matches for xGI, eleven for points per match, never within a season for points per 90. This is why the model projects from xG/xA rather than from points. `reliability.ts` |
| The reliability `k` and the blend `k` agree | **Consistent.** They are different estimands - one is noise-to-signal per appearance, the other is matches-of-form worth one anchor - but for two drift-free windows the optimal share is `n/(n+m)` where `m` is the anchor's length, which is exactly the 1.11-1.20 ratio fitted in the rows above. The stability of ~1.0 for xGI is what licenses that form, and the ratio sitting slightly above 1.0 is the small drift penalty on the older window. `reliability.ts`, `form-weight.ts` |
| Forward correlation for FPL points per match stops improving after ~8 appearances | **Plateaus at r ~ 0.47 (r-squared 0.22) and stays there through 25.** xGI/90 keeps climbing over the same range, 0.58 at two appearances to 0.90 at twenty. More points data does not make points more predictable; more xGI data does. `reliability.ts` |
| Use `n/(n+k)` with k=0.7 for minutes and k=1.2 for starts | **Start calibration improves; minutes and xP are unresolved.** Against 13,104 player-fixtures after a 12-GW anchor, start Brier falls 0.1850 -> 0.1614 (paired 95% delta [-0.0390,-0.0139]); after a 19-GW anchor it falls 0.1683 -> 0.1522 [-0.0273,-0.0086]. Minutes RMSE improves by 0.49 and 0.18 but both intervals cross zero, and xP improves by 0.0248 and 0.0064 with both intervals crossing zero. This tests the fallback minutes model only; historical RotoWire selection sheets do not exist. `evidence-weights.ts` |
| Set current xG/xA share to `currentMatches/(currentMatches+historicalMatches)` | **Reject.** It worsens next-match xG RMSE from 0.2285 to 0.2695 after a 12-GW anchor and 0.2201 to 0.2682 after a 19-GW anchor. Full xP is also worse when minutes are held fixed. Multiplying xA's historical weight by its 4.5/2.0 noise ratio helps against the equal-weight arm but does not beat the shipped blend; winsorising does not rescue it. Reliability says when a sample contains signal, but it is not the right direct blend weight against a player-specific anchor. `evidence-weights.ts` |
| Raise the current/previous effective-match split from the legacy 10/24 | **17/17 was the first safe preference-aligned arm.** It raised the end-season current share from 29.0% to 47.4% while xP stayed statistically tied. Later sweeps below selected 20/10. Dropping the previous season entirely was decisively worse on both splits (+0.0097 and +0.0149 xP RMSE for the 10/0 arm). `evidence-weights.ts` |
| Sweep current-season ceilings 20-38 against previous weight 10 | **Actual points cannot distinguish them.** The 12-GW anchor picks 21/10 at 2.55462 RMSE and the 19-GW anchor picks 20/10 at 2.47306; the full 20-38 ranges span only 0.00003 and 0.00010 RMSE. Every paired interval crosses zero. Prefer 20/10 if points accuracy is the only goal; a larger ceiling is purely a preference for more current-season influence. `evidence-weights.ts` |
| Sweep previous-season weight 1-20 against current ceiling 20 | **The useful range starts around 8 and the main split picks 10.** The 12-GW anchor bottoms at 20/10 (2.55462 RMSE); the 19-GW anchor is effectively flat from weights 11-20 and numerically picks 20/20 (2.47301). Weights 1-4, which give the current season 81-95% by GW38, are worse on both splits. Taken together with the current-ceiling sweep, 20/10 is the simplest fit: 63.2% current-season share at GW38, with no resolved xP difference from shipped. `evidence-weights.ts` |
| Sweep current-season decay 0.80-1.00 against previous weight 10 | **Use 0.94 if one value must cover both splits.** The 12-GW anchor picks 0.95 (2.55462 RMSE), the 19-GW anchor picks 0.91 (2.47296), and pooling their squared errors picks 0.94; 0.93-0.95 are effectively tied. Decay 0.94 leaves 15.08 effective current matches after 38 appearances, so current-season share reaches 60.1% against previous weight 10. Every paired interval crosses zero. `evidence-weights.ts` |
| Ship decay 0.95 with previous weight 10 | **Adopted, then superseded by 6 (below).** It won the main actual-points split and gave current-season xG/xA 63.2% weight after 38 appearances, while retaining 16.3% current weight after two appearances. `lib/projections/playerForm.ts` |
| Sweep prior weight 2-48 for xG and xA separately, three seasons with genuine previous-season anchors | **Adopt 6.** Next-match per-90 RMSE over 17,454 started rows (2023/24-2025/26): overall xG bottoms at 6 (0.23371), xA at 4 (0.13367; 6 at 0.13371, tied), flat across 4-8. Per season: xG 4/10/8, xA 2/12/4. Shipped 10 costs +0.0004 on each — small but consistently signed. Gives 74.1% current weight after 38 appearances, 24.5% after two. `/tmp/sweep-prior-w.ts` (scratch; promote to `scripts/backtest/` before re-running) |
| Lower `regressedPlayerRate`'s 0.6 current-season cap | **Directionally the same, underpowered.** Monotone: cap 0.0 gives xP RMSE 2.7564 against 2.7572 shipped, a 0.0008 gain that sits on the minimum detectable effect. Only bonus moves here - `currentBefore` carries no defensive contributions, saves or cards, so those never enter the blend. `form-weight.ts` |

`anchor.ts` also settled an earlier question: the large attacker bias reported
before it was mostly the harness falling back to a position prior, not a model
defect. Given a per-player anchor, forwards came out near unbiased before cards
were added at all.

## Data

`season.ts` reads `data/generated` unless `BACKTEST_DATA_DIR` is set. Card
columns need a re-ingest; run it to a scratch directory and point the harness
there. **Never run a bare `npm run data:ingest` to test something** —
`data/generated/` is gitignored, so overwriting it destroys the backtest corpus
with no way back:

```bash
BACKTEST_DATA_DIR=/tmp/cards npx tsx scripts/backtest/anchor.ts
```

## Limits

The backtest sets fixture difficulty to a neutral 3, because no FDR exists for
2025/26. "Baseline" in these tables is therefore production with FDR flattened
to 1.0, and every venue and clamp result inherits that. It is also why the outer
multiplier clamp looks inert here when it is not inert in production.

An earlier in-sample check suggested the strongest defences were under-projected
by about 6.7 clean sheets across a season. That does not survive a walk-forward
test: with strengths built only from earlier gameweeks, the top band runs 0.326
actual against 0.331 predicted. The earlier figure was an artefact of giving the
model hindsight strengths, which made the best defence look more extreme than it
was ever predictable to be.

**Nothing in sections 7 or 8 measurably improves a defender.** Every candidate
above was tested and rejected, and the component table says why: appearance is
1.774 of a defender's 3.109 expected points and comes from the minutes model,
which sections 7 and 8 never touch. Clean sheets and goals conceded are 1.161
more and both read a table that survives every test aimed at it. That leaves
0.588 of attacking points and 0.426 of defensive contributions to argue over.

A caution on the two weak-end findings that pointed the other way. `position.ts`
reports +0.474 [+0.072, +0.940] for defender rows below the grid, and the
bottom band of `cleansheets.ts` shows 0.152 actual against 0.208 predicted.
Neither survives contact with `cs-fit.ts`, which is the decisive test: an actual
fitted correction, scored on gameweeks it never saw, loses. Prefer that result.
Fitting the weak end of one season's table is fitting one season's noise.

Snapping is not the reason weak defences are over-projected. 36.4% of defender
rows have one side pinned to an end rung and the whole season yields only 27
distinct clean-sheet probabilities, which looks like a resolution problem and is
not one. The bottom band of defences keeps a clean sheet 0.152 of the time
against 0.208 predicted; interpolation moves that to 0.206 and extrapolation to
0.192, while extrapolation overshoots the top band from 0.331 to 0.382 against
an actual 0.326. The table is the wrong shape at the weak end, not too coarse,
so reading it more precisely reads the same error more precisely.

`form-weight.ts` carries a structural bias that no arm inside it can remove.
Its "previous season" is a block of earlier gameweeks from the *same* season, so
the anchor shares a club, a manager, a role and an age with the rows it is
scored against. A real previous-season anchor crosses a transfer window. The
sweep therefore flatters the anchor, and the true optimum against a genuine
previous season is lower than it reports. That gap is exactly what the 2023/24 +
2024/25 corpus cited by `playerForm.ts` would close, and that corpus is not in
this repository - `season.ts` reads 2025/26 only. Read the result as "this
season gives no support for trusting form more", not as a licence to raise the
constant.

One season, 9,972 player-rows and 660 team-fixtures. The minimum detectable
effect is about ±0.0007 RMSE on xP and ±0.0025 Brier on clean sheets. Several
arms sit inside that band: "no measurable difference" here means the test could
not resolve it, not that the change is proven neutral.

## Schedule-adjusting a player's own form

`blendPlayerRate` averages a player's past match xG/xA with no regard for who he
faced, and the result is then multiplied by the *next* fixture's attack
multiplier. A player coming off a soft run is therefore counted twice. Three arms
over 2022/23-2025/26, `validate.ts` passing on each season:

```
A shipped    blend(r_i)                       x m_next
B form-only  blend(r_i / m_i)                 x m_next
C both       blend(r_i / m_i, prior / m_bar)  x m_next
```

| Change | Verdict |
|---|---|
| Schedule-adjust the form window only (arm B) | **Reject in favour of C.** Normalizing the form half while leaving the anchor raw mixes scales: a player on a strong team keeps an inflated anchor against a deflated form estimate. B is worse than C in all four seasons on next-match RMSE. |
| Schedule-adjust form and anchor together, on production's information (arms D/E) | **Shipped.** Arm C needs walk-forward strengths and a realized anchor multiplier, neither of which production has. Arm D re-scores past matches with *current* strengths and normalizes the anchor by the team's own attack strength; it beats both A and C in every season. Arm E adds the live-FDR asymmetry production really has (base=1 on past matches, live base on the upcoming one) and matches D to 0.001-0.003 RMSE. Gradient A -> E: +0.164 -> +0.034, +0.078 -> -0.040, +0.098 -> -0.003, +0.092 -> -0.011. |
| Schedule-adjust form and anchor together (arm C, idealized) | **Superseded by D.** Kept as the upper bound. RMSE is a wash - 2 of 8 season-metric tests resolve, one in each direction - and it was underpowered by construction: the mean prediction gap between arms is 0.016-0.026 xGI/90 against a residual of 0.17-0.25. What resolves is bias: C shrinks the absolute bias in **8 of 8** season-metric comparisons. `schedule-adjust.ts` |

**The tilt, and what it actually is.** Bias by quintile of `mBar(form)`, the
decay-weighted mean attack multiplier over the matches being averaged. Arm A
rises monotonically across all five quintiles in all four seasons:

| Q5 - Q1 bias gradient, xGI/90 | A shipped | C both | \|C\|-\|A\| (CI95) |
|---|---|---|---|
| 2022/23 (reduced) | +0.164 | +0.064 | -0.100 [-0.105, -0.079] |
| 2023/24 | +0.078 | -0.018 | -0.061 [-0.099, +0.016] |
| 2024/25 | +0.098 | +0.035 | -0.063 [-0.067, -0.059] |
| 2025/26 | +0.092 | +0.007 | -0.085 [-0.089, -0.036] |

C leaves 8-39% of the gradient behind, so it narrows the error without closing
it - except in 2023/24, where it overshoots into a sign flip and starts
under-projecting players off soft runs. The correction's direction is right in
every season; its magnitude is not uniformly right.

**That gradient is mostly not the schedule.** `mBar(form)` loads heavily on team
strength - a strong attack clears 1.0 in nearly every fixture - so the same
monotone rise is predicted by two different defects. Splitting them (pooled
quintiles, three full seasons, `biasBy` at the foot of the script):

- by `mBarForm / mBarAnchor`, the player's recent run against **his own**
  baseline, roughly orthogonal to team level: A's bias is mixed. Non-monotone in
  2023/24, rising in 2024/25 and 2025/26, and never clean.
- by `mBarAnchor` alone, team level with the swing averaged out: A's bias is
  **monotone in all three seasons**, and concentrated in the top quintile
  (2023/24 -0.039 -> +0.055, 2024/25 +0.001 -> +0.076, 2025/26 +0.009 -> +0.090).

So the large, consistent defect is a **level** double count, not a schedule one:
a player's own xG rate already carries his team's attacking quality, and the
fixture multiplier applies that quality a second time. Players on the strongest
attacks are over-projected by roughly 0.05-0.09 xGI/90. The schedule effect that
arm C was built to remove is real but secondary.

Arm C removes most of the level tilt as a side effect, because dividing the
anchor by `mBarAnchor` deflates strong teams' anchors directly. That is the right
symptom treated by the wrong lever. Ship C for its 8/8 bias improvement, but the
finding worth acting on is the level double count, which wants the share
decomposition (player rate = team rate x player share, with the multiplier
scaling only the team half) rather than a schedule adjustment.

**What it costs to ship C.** `PlayerMatchRate` carries
`{playerId, xg, xa, minutes}` and needs `opponentTeamId` and `wasHome`;
`loadInSeasonForm.ts` already has the fixture pairing that supplies them, but the
persisted aggregate is cached, so the schema change needs a version bump and a
re-fetch. Nothing in this test used FPL difficulty - none of these seasons has
it - so `base` stayed at 1.0 and the arms differ only through team strengths and
venue.

## FPL difficulty against the strength ratio

Section 7 multiplies `base`, read from FPL's 1-5 difficulty, by
`ownAttack / opponentDefence`, read from the model's own strengths. Both encode
fixture difficulty, so the suspicion was that one is redundant and the pair
double-counts the opponent. Arms: `BASELINE` against
`{ useDifficultyBase: false }`, which sets `base = 1` whenever both strengths
exist and leaves FDR as the no-strengths fallback it already is.

| Season | corr(base, ratio) | opposite ways | team xG RMSE with / without | residual-after-ratio corr with base | xP RMSE without - with [CI95] | GW sign test |
|---|---|---|---|---|---|---|
| 2022/23 | 0.194 | 30.6% | 0.86246 / 0.87408 | +0.089 | +0.00417 [+0.0014, +0.0069] | 23/32 |
| 2023/24 | 0.457 | 27.9% | 0.51706 / 0.51793 | +0.055 | 0.00000 [-0.0049, +0.0050] | 20/33 |
| 2024/25 | 0.631 | 9.7% | 0.53333 / 0.53739 | +0.071 | +0.00203 [-0.0012, +0.0052] | 20/33 |
| 2025/26 | 0.460 | 9.5% | 0.52499 / 0.52678 | +0.157 | -0.00012 [-0.0034, +0.0031] | 20/33 |

**Verdict: keep both.** The redundancy story does not survive contact with the
data. The two terms correlate at only 0.19-0.63 and disagree in direction on up
to a third of team-fixtures, and after regressing actual team xG on the strength
ratio the residual still moves with `base` in every season. Dropping `base`
raises team-xG RMSE in 4 seasons of 4. On xP it is close to a null - one season
resolves, three span zero - but the sign is consistent, and team xG is the
sharper instrument for an attacking term, exactly as `sweep.ts` argued.

The open question is the *weighting*. Two partially correlated signals are
combined by plain multiplication, which is an assumption nobody has fitted.

**The table above no longer reproduces at HEAD.** Commit 79eafa3 changed
`lib/historical/enrichPlayers.ts` and `loadInSeasonForm.ts`, which moves the team
strengths every column here is built on - including the `without base` arm, which
never touched FDR. Re-running `fdr.ts` unchanged now gives corr(base, ratio)
0.575 and 0.403 for 2024/25 and 2025/26 against the 0.631 and 0.460 recorded
here, and team xG RMSE 0.53679 / 0.54124 against 0.53333 / 0.53739. The verdict
is unchanged in sign and size; the numbers are stale. Do not compare them against
the ClubElo section below, which was measured at HEAD.

**Bonus, now that `base` is live in the harness:** the outer multiplier clamp
binds on 0.8% (2022/23), 4.4%, 6.4% and 3.8% of team-fixtures. README previously
recorded that this could not be checked here "because FDR is neutralized in the
backtest". It can be now.

### A note on what `validate.ts` gates after this change

`formBefore` in `season.ts` does not attach `opponentTeamId` / `wasHome`, so the
form entries the harness feeds `projectPlayer` carry no fixture context and the
schedule adjustment falls back to the raw blend. `validate.ts` therefore still
reproduces `projectPlayer()` exactly, but it is now gating the *unadjusted* path.
The adjusted path is covered by `tests/core/schedule-adjusted-form.test.ts` and
by `schedule-adjust.ts`, which computes its arms standalone rather than through
`xp.ts`. Porting the adjustment into `xp.ts` would move the baseline for every
arm recorded above, so it was left alone deliberately.

## ClubElo difficulty: the gap, or the opponent alone?

`normalizeFixtures` now replaces FPL's published rating with one read off a
ClubElo snapshot, `clamp(round(3 + (Eopp - Eown_venue) / 200), 1, 5)`. That is a
function of the Elo *difference*, so the two sides of a fixture always sum to 6
and 187 of 2026/27's 380 fixtures score 3/3 - Arsenal against Man City (FPL 4/5)
and Hull against Sunderland (FPL 2/2) come out identical. Since `base`
multiplies the attack term, and attacking output depends on the quality of the
defence being faced, the objection was that the rating should read the opponent
absolutely rather than relatively.

Tested as a continuum rather than two points. `MIX(w)` subtracts `w` of the own
side's rating; `w = 1` is the shipped gap formula, `w = 0` reads the opponent
alone, and the divisor grows with the spread of the numerator so every weight
produces a comparable 1-5 spread. `elo-history.ts`, `elo-fdr.ts`.

Team xG, correlation of the attack multiplier with actual team xG:

| Season | w=0 | w=0.25 | w=0.5 | w=0.75 | w=1 (shipped) | FPL | none |
|---|---|---|---|---|---|---|---|
| 2023/24 | 0.4777 | 0.4854 | 0.4858 | 0.4930 | 0.4920 | 0.4809 | 0.4831 |
| 2024/25 | 0.4173 | 0.4235 | 0.4290 | 0.4302 | **0.4328** | 0.4321 | 0.4112 |
| 2025/26 | 0.3543 | 0.3562 | 0.3611 | 0.3623 | 0.3651 | **0.3704** | 0.3493 |

**Verdict: reject the change to opponent-only, keep the gap.** `w` improves
monotonically toward 1 in all three seasons on both correlation and team-xG
RMSE. Individually the differences are inside the noise - `w = 0` costs
+0.00378 [-0.0018, +0.0098] team-xG RMSE in 2024/25 and +0.00044 [-0.0047,
+0.0051] in 2025/26 - but three seasons agreeing on the direction is the
evidence, and it points away from the proposal.

The expressiveness argument was right about what the formula *cannot say* and
wrong about it mattering. The reason is visible in the residual column: after
regressing team xG on the strength ratio, the residual still moves with the gap
`base` (0.097 and 0.139) and barely moves with the opponent-only `base` (0.036
and 0.078). A ratio `ownAttack / opponentDefence` cancels the *level* of the two
sides; the gap `base` keeps a read on own-team quality that the ratio has
divided away. That is signal the model does not otherwise carry, which is also
the answer to the redundancy worry above - `corr(base, ratio)` rises from 0.575
to 0.758 when FPL's rating is swapped for the Elo gap, and the residual
correlation does not fall.

**Reject a tighter divisor; 300 is unresolved.** `GAP(130)` is significantly
worse than the shipped 200 in both evaluation seasons (+0.00293 [+0.0005,
+0.0054] and +0.00357 [+0.0001, +0.0069]) and binds the outer multiplier clamp
on 13% of team-fixtures against 6-10%. `GAP(300)` is directionally better in two
seasons of three and binds on 3%, but no interval resolves, so 200 stands.

**Unresolved: ClubElo against FPL.** FPL's own rating is significantly better in
2025/26 (-0.00567 [-0.0110, -0.0009]), a null in 2024/25 and worse in 2023/24.
This comparison is not clean - see the scope limit below - so it is recorded,
not concluded from.

### Scope limits

- **These are not ClubElo's ratings.** ClubElo's history API returns 502 and
  `clubelo.com/<date>/ENG` redirects to the front page, so no dated historical
  values are obtainable. `elo-history.ts` computes ratings from the corpus's own
  match results instead: K=20 with the World Football Elo goal-difference term,
  65 Elo points of home advantage, chained across seasons by club name, promoted
  clubs entering at the mean of the relegated, then rescaled to the real
  snapshot's mean 1830 / sd 120 using burn-in seasons only. A difference between
  `MIX` arms is a difference of *formula* - they read identical ratings. A
  difference against FPL confounds the rating source with the formula.
- **2022/23 and 2023/24 are Elo burn-in.** A flat-seeded rating is compressed
  toward the mean for most of a season. Opening league sd runs 0, 123, 150, 153
  across the four seasons; only 2024/25 and 2025/26 are evaluated on a converged
  rating.
- **The player-xP block is unguarded.** `validate.ts` fails at HEAD, so xP
  numbers from this script are reported but carry no replication gate. On xP,
  flatter arms win - `NONE`, which makes every fixture neutral, beats the
  shipped formula - which is what a sum of squares over single-match points
  rewards regardless of whether the signal is real. Team xG is the instrument.
