# Section 7 backtest

Walk-forward test of the fixture-adjustment model against the ingested 2025/26
season. Everything a projection sees at gameweek `t` comes from gameweeks before
`t`.

```bash
npx tsx scripts/backtest/validate.ts      # gate: harness must reproduce projectPlayer()
npx tsx scripts/backtest/run.ts           # section 7 variants scored on section 8 xP
npx tsx scripts/backtest/cleansheets.ts   # the clean-sheet model scored directly
npx tsx scripts/backtest/sweep.ts         # clamp-width sweep and team-goals test
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
| Drop FPL difficulty when strengths exist | **Untestable here.** No FDR exists for 2025/26. In the 2026/27 snapshot home FDR only ever takes 2, 3 or 4, so `base` spans 1.07–0.92, not 1.14–0.84. |

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

One season, 9,972 player-rows and 660 team-fixtures. The minimum detectable
effect is about ±0.0007 RMSE on xP and ±0.0025 Brier on clean sheets. Several
arms sit inside that band: "no measurable difference" here means the test could
not resolve it, not that the change is proven neutral.
