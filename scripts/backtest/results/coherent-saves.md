# Coherent goalkeeper saves — 2026-09-11

Run by `scripts/backtest/coherent-saves.ts` on freshly prepared 2022/23–2025/26
corpora (new ingest carrying per-match `goalsConceded`; see below). Walk-forward,
gameweeks 2–38, 3,002 goalkeeper appearances pooled. Minutes are actual, as in
`run.ts`, so the minutes model does not bury the signal.

## Verdict: reject. Coherence narrows the spread but accuracy gets worse.

Pooled, all gameweeks (3,002 appearances; deltas vs shipped, 95% paired
gameweek-cluster intervals):

| Arm | saves RMSE | ΔRMSE | 95% CI | verdict | saves-pts Δ | shots Δ | GK xP Δ [95% CI] | impl save% sd |
|---|---|---|---|---|---|---|---|---|
| **shipped** | **1.89965** | — | — | — | — | — | — | 0.0361 |
| coherent k=0 | 3.17865 | +1.27900 | [+0.73, +1.82] | **worse** | +0.3263 | +1.1209 | +0.1160 [+0.050, +0.174] | 0.0769 |
| coherent k=20 | 2.00211 | +0.10246 | [+0.08, +0.13] | **worse** | +0.0323 | +0.1057 | +0.0038 [-0.003, +0.010] | 0.0417 |
| coherent k=50 | 1.96808 | +0.06843 | [+0.05, +0.09] | **worse** | +0.0217 | +0.0778 | +0.0009 [-0.005, +0.006] | 0.0321 |
| coherent k=100 | 1.95057 | +0.05092 | [+0.03, +0.07] | **worse** | +0.0162 | +0.0630 | -0.0005 [-0.006, +0.005] | 0.0252 |
| coherent k=200 | 1.94021 | +0.04055 | [+0.02, +0.06] | **worse** | +0.0130 | +0.0536 | -0.0013 [-0.007, +0.004] | 0.0198 |
| coherent k=500 | 1.93530 | +0.03564 | [+0.02, +0.06] | **worse** | +0.0115 | +0.0484 | -0.0017 [-0.007, +0.004] | 0.0160 |
| coherent k=Inf (league rate) | 1.93700 | +0.03735 | [+0.02, +0.06] | **worse** | +0.0121 | +0.0484 | -0.0016 [-0.007, +0.005] | 0.0154 |

Every kappa loses on saves RMSE with the interval excluding zero, including
k=Infinity — saves as a pure function of the team's lambda is also worse than
the shipped rate. Goalkeeper xP deltas are all inside ±0.007 and unresolved in
both directions, so the acceptance bar (saves improves resolved **and** xP does
not get worse) fails on its first clause. The early window (GW 2–5, 320 rows)
is unresolved everywhere, so no small-sample rescue either. Per-season
all-gameweeks saves deltas at k=100: 2022/23 +0.067 [+0.035, +0.096], 2023/24
+0.059 [+0.010, +0.104], 2024/25 +0.014 [-0.027, +0.060], 2025/26 +0.064
[+0.033, +0.095] — all four point estimates on the worse side, three resolved.

## Mechanism: the keeper's rate carries volume signal lambda does not have

The proposal assumed `rates.saves` was skill measured behind a specific defence
(a double count once `savesEnvironment` applies the current defence). The
outcomes say the opposite: replacing the keeper's own volume estimate with the
team model's lambda *loses* information. Shipped saves + lambda predicts the
joint total (saves + goals conceded) better than the coherent pair at every
kappa (pooled shots ΔRMSE +0.05 to +0.08, all on the worse side) — the keeper's
rate knows how many shots his team faces, because bad teams both face more
shots and employ the keepers who have faced more shots. That is the double
count running in reverse: the "team environment already in the rate" is load
bearing, not redundant.

The k=0 arm is catastrophic (+1.28 pooled, +5.6 in GW 2–5 2025/26): an
unregularised empirical save percentage from a handful of shots explodes
through `lambda * p / (1 - p)`. The 0.95 clamp keeps it finite, not sane.

## What the change does achieve

The implied save-percentage spread narrows as designed (pooled sd 0.036
shipped → 0.015 at k=Inf), and the live ranking check
(`scripts/experiments/sweep-gk-save-percentage.ts`) confirms the table symptom
is mostly lambda, not the rate: Martinez (CHE) stays #1 by nextGW under every
kappa (3.95 shipped → 3.72–3.80 coherent) and drops only to 4th–6th by
next5/next10 as his save points compress toward the league rate. A ranking
change is not evidence of correctness, and here it points the same way as the
accuracy verdict: the 16-point shipped spread is ugly, but the keepers at its
ends are there for reasons the outcomes endorse.

## Risks checked

- **Coupling.** corr(saves error, lambda error) is 0.037 shipped vs 0.057
  coherent pooled — both negligible. Saves do not inherit team-model error in
  any material way under either parameterisation.
- **Shot quality.** xGA-per-shot by team runs 0.266–0.327 (sd 0.0168) around
  ~0.30: a ±10% band, roughly constant quality. Not the driver; no
  team-xGA-per-shot follow-up arm is warranted on this evidence.
- **Penalties and red cards.** The eight worst coherent residuals are
  shot-volume tails (10–13 saves conceded 0–4; 0 saves conceding 4–5), with no
  yellow or red cards attached. Discipline distortions do not drive the result.
  (The residual print's team-goals column is the keeper's own goals, always 0.)

## Plumbing notes (kept; the finding is not)

- `merged_gw.csv` carries `goals_conceded` and `expected_goals_conceded` for
  every season 2022/23 onward. The ingest (`lib/historical/ingest.ts`) now
  emits both per match and in the season aggregate; `HistoricalStats`,
  `HistoricalMatchStat`, `MatchRow` and `currentBefore` carry them with the
  same absent-means-degrade rule the `saves` column established, and the live
  bundle schemas (`lib/historical/schemas.ts`) accept them — without that last
  piece zod strips the new columns on load and the league rate reads 1.0.
- `keeperSavePercentage` and the default-off `savePercentageKappa` override
  (`lib/projections/projectPlayer.ts`, `lib/historical/enrichPlayers.ts`)
  follow the `savesPriorWeight` precedent: unset reproduces shipped exactly,
  which `validate.ts` (0.000e+0 on all four prepared seasons) and
  `tests/core/coherent-saves.test.ts` both gate. They exist so the live-table
  question stays answerable without editing a constant.

## Reproduction

```bash
BACKTEST_ROOT=$(mktemp -d)
BACKTEST_MULTI_DATA_DIR=$BACKTEST_ROOT npx tsx scripts/backtest/prepare-seasons.ts
BACKTEST_MULTI_DATA_DIR=$BACKTEST_ROOT npx tsx scripts/backtest/elo-history.ts
for season in 2022-23 2023-24 2024-25 2025-26; do
  BACKTEST_DATA_DIR=$BACKTEST_ROOT/$season BACKTEST_CASE_OUT=/tmp/cs-$season.json \
    npx tsx scripts/backtest/coherent-saves.ts
done
npx tsx scripts/backtest/coherent-saves.ts --pool /tmp/cs-2022-23.json /tmp/cs-2023-24.json /tmp/cs-2024-25.json /tmp/cs-2025-26.json
npx tsx scripts/experiments/sweep-gk-save-percentage.ts "Martinez" CHE
```

Never write to `data/generated`: the prepared root above is scratch by
construction. `BACKTEST_DATA_DIR` is read at module import, so each season runs
in its own process.
