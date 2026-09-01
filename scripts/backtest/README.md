# Section 7 backtest

Walk-forward test of the fixture-adjustment model against the ingested 2025/26
season. Everything a projection sees at gameweek `t` comes from gameweeks before
`t`.

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
```

`validate.ts` reproduces `projectPlayer()` to 0.0e+0 on all 9,972 played rows, so
an arm difference is a model difference and not a harness difference. Run it
first; the other scripts are meaningless if it fails.

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
| Ship decay 0.95 with previous weight 10 | **Adopted as the preference-aligned point inside the tied 0.93-0.95 band.** It won the main actual-points split and gives current-season xG/xA 63.2% weight after 38 appearances, while retaining 16.3% current weight after two appearances. `lib/projections/playerForm.ts` |
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
