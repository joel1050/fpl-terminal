# Task: make goalkeeper saves and goals-conceded coherent

Self-contained brief. You are working in the FPL Terminal repo (see `AGENTS.md`
and `calculations.md`). Read `scripts/backtest/README.md` before you start.

## The defect

Two numbers describe the same fixture, and the model computes them from
unrelated sources that are never reconciled:

- **Goals conceded** comes from the team model:
  `adjustment.expectedGoalsAgainst`, built from team strengths and ClubElo in
  `lib/projections/fixtureAdjustment.ts`.
- **Saves** come from the player's own per-90 history:
  `rates.saves` in `lib/projections/projectPlayer.ts`, via `regressedPlayerRate`,
  then multiplied by `savesEnvironment = clamp(expectedGoalsAgainst / 1.35, 0.7, 1.4)`.

Saves and goals conceded are two halves of one quantity — shots on target faced.
Estimating them separately lets the model assert combinations that cannot both
be true. Inverting the shipped gameweek-4 projections back to shots
(`E[floor(S/3)]` is monotonic in the Poisson mean, so it inverts cleanly):

| keeper | shots faced | goals conceded | implied save % |
|---|---|---|---|
| Martinez (CHE) | 3.09 | 0.81 | **73.7%** |
| Henderson (CRY) | 3.43 | 1.06 | 69.0% |
| Horníček (NEW) | 4.34 | 1.45 | 66.7% |
| Becker (LIV) | 2.91 | 1.03 | 64.4% |
| Donnarumma (MCI) | 3.36 | 1.24 | 63.1% |
| Raya (ARS) | 2.36 | 1.01 | 57.3% |

The league save percentage is **0.661**. A 16-point spread is not keeper skill;
it is the volume estimate and the concession estimate disagreeing. The concrete
symptom: the model has Chelsea facing 31% more shots than Arsenal while
conceding 20% fewer goals, which puts Chelsea's keeper top of the 1, 5 and
10-gameweek tables.

There is also a double-count. `rates.saves` is a rate earned behind a specific
defence, so it already contains a team environment; `savesEnvironment` then
applies the *current* team's environment on top. Compare `regressedFormRate`,
which explicitly divides out the source team's attack for xG and xA
("historical rates are player-plus-team evidence") — `regressedPlayerRate` does
no such thing.

## The proposed change

Reparameterise. Take **volume** from the team and **skill** from the player:

```
lambda   = adjustment.expectedGoalsAgainst          (team model, unchanged)
p        = the keeper's save percentage             (player skill, regressed)
shotsOnTargetFaced = lambda / (1 - p)
expectedSaves      = lambda * p / (1 - p)
```

Saves and goals conceded now descend from one `lambda`, so they are coherent by
construction and the implied save percentage is `p` by definition.
`savesEnvironment` and its `[0.7, 1.4]` clamp are deleted — volume already comes
from `lambda`, so the multiplier has nothing left to do.

Estimate `p` as a Beta-binomial, since it is a bounded proportion from a small
count:

```
p = (saves + kappa * p0) / (saves + goalsConceded + kappa)
p0 = league save percentage (0.661 currently; compute it walk-forward, do not hardcode)
```

`kappa` is the prior's weight in equivalent shots faced. **Sweep it**:
`{0, 20, 50, 100, 200, 500, Infinity}`. Blend previous-season and current-season
shot counts the way the rest of the model blends evidence.

`kappa = Infinity` gives every keeper the league save percentage, which makes
saves a pure function of the team's `lambda`. Treat that as a serious arm, not a
straw man: shot-stopping is widely found to be close to noise year over year, and
if it wins here that is the finding — it would mean keeper save projections are
a team ranking, and it would simplify the model considerably.

## What you need to build first

`historical-match-stats.json` does not carry `goals_conceded` per match, so `p`
cannot be estimated walk-forward yet. The `saves` column was added for
`scripts/backtest/saves-weight.ts` — follow exactly that pattern:

1. Add `goalsConceded?: number` (and `expectedGoalsConceded?: number`, see below)
   to `HistoricalMatchStat` in `lib/historical/types.ts`.
2. Emit them in `normalizeHistoricalMatchStats` in `lib/historical/ingest.ts`.
   The vaastav `merged_gw.csv` columns are `goals_conceded` and
   `expected_goals_conceded`; both exist for every season 2022/23 onward.
3. Add the fields to `MatchRow` and to `currentBefore` in
   `scripts/backtest/season.ts`, guarded so a corpus without them degrades
   rather than reporting zeros.
4. Re-run `prepare-seasons.ts` and `elo-history.ts` into a scratch root. Never
   write to `data/generated`.

## The test

Write `scripts/backtest/coherent-saves.ts`, modelled on
`scripts/backtest/saves-weight.ts`, which already has the shape you need.

- **Corpora**: prepared 2022/23–2025/26, walk-forward, gameweeks 2–38. Report
  gameweeks 2–5 and 6–38 as separate windows as well as pooled; a `--pool` mode
  that merges per-season case dumps is the established pattern.
- **Arms**: shipped as arm 0 (every delta must be measured against it), then the
  reparameterisation at each `kappa`.
- **Instruments**, in this order of authority:
  1. **Saves RMSE** and saves-points RMSE against actual saves. This is the
     quantity being changed and where the power is.
  2. **Joint coherence**: RMSE of predicted `saves + goalsConceded` against the
     actual total, and the spread of implied save percentage across keepers. The
     change should sharply narrow that spread; verify it does.
  3. **Whole-player xP RMSE for goalkeepers**, using actual minutes as `run.ts`
     does, so the minutes model does not bury the signal.
- **Significance**: paired bootstrap over **gameweek clusters**, not rows —
  keepers in one round share fixtures. Report 95% intervals and the per-season
  deltas, not just the pooled number.
- **Parity gate**: `scripts/backtest/validate.ts` must still reproduce
  `projectPlayer()` at `0.000e+0` on every played row of every prepared season.
  Any new option must default to shipped behaviour.

## Then, and separately, the ranking effect

Only after the accuracy verdict, run the live ranking check. Use
`scripts/experiments/sweep-gk-saves-weight.ts` as the template; it threads an
inert override through `ProjectPlayerOptions` and `enrichPlayersWithHistory` and
asserts that the shipped value reproduces the default table exactly. Do the same
for `kappa`.

Report, for each `kappa`, the goalkeeper table by `nextGW`, `next5` and
`next10`, the implied save percentage spread, and where Chelsea's Martinez
lands. **A ranking change is not evidence of correctness.** State the accuracy
verdict first and keep the ranking table subordinate to it.

## Risks to test, not to assume away

- **Coupling.** Saves now inherit any error in `lambda`. The team model is known
  to be optimistic about a side that has started badly — see
  `scripts/backtest/results/cs-level-source.md`. Check whether saves get worse
  for teams whose `lambda` is furthest from their realized concession.
- **Shot quality.** `lambda / (1 - p)` assumes every team faces shots of the same
  quality. They do not. This is why you should ingest `expected_goals_conceded`:
  compare `lambda / (1 - p)` against realized shots faced, by team, and say
  whether the constant-quality assumption holds. If it does not, an arm that
  scales volume by team xGA-per-shot is the natural follow-up.
- **Penalties and red cards** distort both halves in a handful of matches. Check
  the residuals are not driven by a few rows.

## Acceptance

Ship only if saves RMSE improves with a paired interval excluding zero on the
pooled corpus **and** the per-season deltas share a sign, **and** goalkeeper xP
RMSE does not get worse. If the coherence spread narrows but accuracy does not
improve, that is an interesting negative result: write it up and do not ship.

Write the verdict to `scripts/backtest/results/coherent-saves.md` following the
format of the existing files there — verdict table first, mechanism second,
caveats explicit, reproduction commands at the end — and add one row to the
verdict table in `scripts/backtest/README.md`.

Most changes tested in this repo do not resolve. A clean rejection, reported
honestly with the intervals that produced it, is a successful outcome. Do not
tune constants until something looks better than shipped.

## Verify before you claim anything

```bash
npm test && npm run typecheck && npm run lint
for season in 2022-23 2023-24 2024-25 2025-26; do
  BACKTEST_DATA_DIR=$BACKTEST_ROOT/$season npx tsx scripts/backtest/validate.ts
done
```
