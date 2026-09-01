# Calculations spec

This document describes how every metric in FPL Terminal is calculated. It keeps three things separate on purpose: **facts** (live FPL data), **evidence** (history, RotoWire), and **estimates** (projections, risk, confidence). Each estimate is traceable to the inputs that produced it.

Source files are referenced as `path:line`.

---

## 1. Units and conventions

- **Money** is stored as integer tenths of a pound: `105` means £10.5m. Convert only for display (`priceTenths / 10`).
- **Minutes** are always on a 0–90 scale for a single fixture.
- **Probabilities** are on a 0–1 scale.
- **Rates** (xG, xA, bonus, saves, defensive contributions) are always **per 90 minutes**.
- **xP** (expected points) is a mean expectation, never a simulated sample.
- **Horizons** are `1 | 3 | 5` gameweeks, counting *distinct* gameweeks (see §9).

---

## 2. Inputs and normalization

Live FPL bootstrap data is normalized in `lib/fpl/normalize.ts`.

### 2.1 `current` stats (facts)

From `normalizePlayer` (`lib/fpl/normalize.ts:207`):

| Field | Source |
|---|---|
| `totalPoints` | `rawPlayer.total_points` |
| `pointsPer90` | `total_points / (minutes / 90)` when `minutes > 0` |
| `goals`, `assists`, `cleanSheets`, `bonus`, `minutes`, `saves` | matching bootstrap fields |
| `expectedGoals`, `expectedAssists` | `expected_goals`, `expected_assists` |
| `yellowCards`, `redCards` | `yellow_cards`, `red_cards` |
| `status` | FPL status string (`i`, `d`, `s`, `u`, `n`, …) |
| `chanceOfPlaying` | `chance_of_playing_next_round` (may be null) |
| `priceTenths` | `now_cost` |
| `ownership` | `selected_by_percent` |

### 2.2 Fixtures and difficulty (facts)

`playerFixtures` (`lib/fpl/normalize.ts:183`) builds each player's fixture list. `difficulty` is the FPL fixture difficulty rating (1–5) for the player's side (home uses `team_h_difficulty`, away uses `team_a_difficulty`).

### 2.3 Historical stats (evidence)

`lib/historical/ingest.ts` aggregates the `merged_gw.csv` season file. Season totals are summed, then converted to per-90 where needed. `HistoricalStats` carries `minutes`, `starts`, `totalPoints`, `goals`, `assists`, `cleanSheets`, `saves`, `bonus`, `bps`, `influence`, `creativity`, `threat`, `expectedGoals`, `expectedAssists`, `xGIPer90`, `pointsPer90`, `defensiveContribution`, `yellowCards`, and `redCards`.

Players are linked to history via `playerMappings` (EXACT by code, else LIKELY by normalized name+team).

### 2.4 RotoWire (evidence)

`lib/availability/rotowire.ts` parses the predicted/confirmed lineups. Each record is one of:

- `STARTER` with `lineupStatus` `PREDICTED` or `CONFIRMED`, or
- `UNAVAILABLE` with `availabilityStatus` `QUES` / `OUT` / `SUS`.

Names are mapped to FPL player ids in `lib/availability/rotowireMapping.ts` (confirmed mapping, exact name, unique fallback; ambiguous/unmapped records are rejected).

---

## 3. Team strength

Team strength is a three-layer estimate: a preseason consensus, blended with last season's real attack/defence split, further blended with this season's in-season form as matches are played. Each layer only ever nudges the one before it — none of them fully overrides an earlier layer.

### 3.1 Preseason consensus (attack and defence, independently)

`data/manual/team-strengths.json` carries one **overall** tier and separate **attack** and **defence** tiers (1-5) per club. Returning clubs' attack/defence split is derived from their 2025/26 FPL attack/defence strength ratios, averaged 50/50 with the overall consensus tier and rounded to the nearest whole tier; promoted clubs with no top-flight history reuse the overall tier for both (documented in the file's own `method` field). Each tier is converted with:

```
consensus = 0.76 + tier * 0.08        // tier in 1..5
```

`0.76 + tier * 0.08` isn't an arbitrary rescale: it lands tier 1-5 exactly on `0.84, 0.92, 1.00, 1.08, 1.16` - the same five anchors the clean-sheet probability table (§7.4) was calibrated against. A raw 1-5 integer would both break every multiplier that assumes "1.0 = average" and make `nearestStrengthTier` (§7.4) snap almost every team to the wrong table row.

`consensusRatio` (`lib/historical/enrichPlayers.ts:60`) applies this to `rating` (overall), `attackRating`, and `defenceRating` independently (`lib/fpl/normalize.ts:34`, `NormalizedTeam.strength`). If a club has an overall tier but no separate attack/defence split yet, attack and defence both fall back to the overall tier rather than being left undefined.

If no consensus tier exists at all for a dimension, the raw home/away/attack/defence strengths from the bootstrap payload are used instead (falling back to 1.0).

### 3.2 Normalization by source

`deriveTeamStrengths` (`lib/historical/enrichPlayers.ts:80`) divides each team's value by a **league average**, but consensus ratios (~0.84-1.16) and raw FPL fallback fields (which can run in the hundreds) are never averaged into the same pool - `normalizeBySource` (`lib/historical/enrichPlayers.ts:73`) computes the mean separately within the consensus group and within the fallback group, per dimension, so a club without a manual tier can't crush every other club's ratio onto its scale:

```
attackHome = attackHome.value / mean(attackHome values from the same source: consensus or fallback)
attackAway = attackAway.value / mean(attackAway values from the same source)
defenceHome = defenceHome.value / mean(defenceHome values from the same source)
defenceAway = defenceAway.value / mean(defenceAway values from the same source)
overall    = (overallHome + overallAway) / 2, each normalized the same way
```

A value above 1.0 means above average in that dimension. Attack and defence are not split by venue at the consensus layer - `attackHome` and `attackAway` share the same consensus value; venue only enters later as the flat home/away multiplier in §7.1.

### 3.3 In-season form (recency-weighted xG)

Once matches are played, `applyInSeasonForm` (`lib/historical/inSeasonForm.ts:102`) blends the §3.1-3.2 prior with each team's own recent process, using **expected goals (xG)**, not goals scored and not win/draw/loss. A backtest across the 2023/24 and 2024/25 seasons found goals and win/draw/loss both perform *worse* than never updating the prior at all (goals are dominated by finishing variance; win/draw/loss collapses attack and defence into one undifferentiated signal); xG clearly improved clean-sheet prediction (AUC) and goals-scored correlation in both seasons individually.

Each finished match contributes a weight that decays with recency, so recent matches dominate without a hard cutoff (`blendInSeasonForm`, `lib/historical/inSeasonForm.ts:43`):

```
weight(i matches before the most recent)  = decay^i
weightedXgFor      = Σ(weight_i * xgFor_i) / Σ(weight_i)
weightedXgAgainst  = Σ(weight_i * xgAgainst_i) / Σ(weight_i)
observedAttack     = weightedXgFor / leagueAverageXg
observedDefence    = leagueAverageXg / max(weightedXgAgainst, 0.15)     // inverted: fewer conceded = higher
effectiveMatches   = Σ(weight_i)                                        // caps at 1/(1-decay) as matches accumulate
blended            = (prior * priorWeight + observed * effectiveMatches) / (priorWeight + effectiveMatches)
```

`decay = 0.90`, `priorWeight = 10` (`DEFAULT_DECAY`/`DEFAULT_PRIOR_WEIGHT`, `lib/historical/inSeasonForm.ts:25`) are backtested against the app's actual prior granularity (a 5-tier consensus quantized the same way §3.1 quantizes it), not guessed - both sit in a flat plateau (decay 0.85-0.95, priorWeight 7-13 all land within ~0.1% AUC of each other), so this is a defensible default, not a razor's-edge optimum. The blend stays venue-agnostic like the prior: a venue-split variant (separate home/away xG streams) was tested and rejected - it won in one backtest season and lost in the other, because splitting an already-thin sample by venue adds noise faster than it adds signal.

`overall` is derived from the blended attack/defence average rather than tracked as a separate consensus number, since nothing downstream consumes `overall` for scoring.

`lib/historical/loadInSeasonForm.ts` supplies the observed data: once every fixture in a gameweek is finished, it sums each player's live `expected_goals` (`event/{gw}/live/`) by team, pairs each fixture's two teams to get xG-for/xG-against, and persists the small aggregate so an immutable gameweek is never re-fetched from FPL again. Double Gameweeks are skipped because the event feed aggregates each player's xG across the whole gameweek and cannot separate it by fixture. A gameweek whose aggregate sums to zero across every team is treated as unresolved (likely an upstream field rename) rather than cached as a false shutout.

---

## 4. Selection / availability model

`buildPlayerSelections` (`lib/availability/selection.ts:237`) produces a `PlayerSelection` for every player. It blends three signals: historical starts, RotoWire lineups, and official FPL status.

### 4.1 Historical signal

`historicalSignal` (`lib/availability/selection.ts:63`) computes:

```
sample    = max(matches, starts, ceil(minutes / 90))
startRate = starts / sample
cameoRate = clamp(max(0, appearances - starts) / sample, 0, 1 - startRate)
```

`starts` comes from the recorded `starts` count when present, otherwise from the number of matches with `minutes >= 60`. Start and cameo minute averages come from the top-`starts` and remaining appearance rows, respectively.

### 4.2 Fallbacks

When there is no historical sample (`lib/availability/selection.ts:102`):

```
fallbackStartRate = current.minutes <= 0 ? 0.15 : clamp(0.1 + minutes / 1800, 0.15, 0.8)
fallbackCameoRate = current.minutes > 0 ? 0.12 : 0.08
```

### 4.3 Blending

```
start = historicalStart * 0.75 + fallbackStartRate * 0.25
cameo = historicalCameo * 0.75 + fallbackCameoRate * 0.25
```

If the player's team is covered by RotoWire, the RotoWire signal dominates:

```
rotowireStart = starter ? (confirmed ? 0.96 : 0.90) : 0.10
rotowireCameo = starter ? 0.05 : 0.12
start = rotowireStart * 0.75 + historicalStart * 0.25
cameo = rotowireCameo * 0.75 + historicalCameo * 0.25
```

RotoWire's own `UNAVAILABLE` records then apply. `OUT` and `SUS` are rulings, not doubts, and gate as hard as FPL's unavailable codes (§4.4) - start and cameo are capped at `0.01`. Only `QUES` is soft, and it is resolved against FPL's status rather than multiplied with it.

### 4.4 Official status gate

`officialAvailability` (`lib/availability/selection.ts:143`) applies a final factor, based only on `player.status`'s short FPL code (`i`, `d`, `s`, `u`, `n`, …) - never free text, so there is no separate wording-based path:

- Unavailable (`i`, `u`, `n`, `s`): `factor = 0.01`, then multiplied by `chanceOfPlaying / 100` when present; start/cameo are additionally capped at `0.01`.
- Doubtful (`d`): `factor = chanceOfPlaying / 100` directly when FPL has supplied a percentage - `chanceOfPlaying` is already FPL's specific estimate for this player, so it is used as-is rather than discounted further. `factor = 0.7` only when no percentage is available.
- Otherwise `factor = 1`.

### 4.4.1 Precedence, not a product

FPL's doubtful flag and RotoWire's `QUES` are usually the same injury reported twice, so they are never multiplied together. Two rules apply:

- **The hard gate always wins.** If FPL rules a player out (`i`, `u`, `n`, `s`), or RotoWire records `OUT`/`SUS`, start and cameo are capped at `0.01` and nothing below runs. A predicted XI is a forecast published before the news: on the snapshot taken 21 August 2026, **53 of 310** RotoWire starters were players FPL had already given a 0% chance of playing. RotoWire never overrides that.
- **Otherwise the single most severe discount applies**, not the product. A predicted starter carrying both RotoWire `QUES` and FPL's 75% used to land near `0.43` - reading as a rotation risk rather than the likely starter RotoWire had named.

When RotoWire still names a doubtful player in the XI, that lineup is the later and more specific judgement and sets a floor rather than being multiplied away: `0.62` for a predicted XI, `0.80` for a confirmed team sheet (`ROTOWIRE_PREDICTED_FLOOR`/`ROTOWIRE_CONFIRMED_FLOOR`). Neither floor applies on the hard-gate path.

None of this is backtested - there is no RotoWire archive for a past season, only the current snapshot - so it is held in place by deterministic tests in `tests/data/rotowire-precedence.test.ts` instead.

`evidenceFor` (`lib/availability/selection.ts:183`) also surfaces `player.news` - FPL's free-text injury/return note - as an `FPL_STATUS` evidence entry when present, so it is visible even though it does not adjust any probability.

### 4.5 Scenario normalization

`normalizeScenarios` (`lib/availability/selection.ts:214`) produces `startProbability`, `cameoProbability`, and `noAppearanceProbability`. If `start + cameo <= 1`, the remainder is "no appearance"; otherwise both are rescaled by their sum and no-appearance is 0.

### 4.6 Expected minutes (selection model)

```
expectedStartMinutes = clamp(history.startMinutes ?? START_MINUTES[position], 60, 90)
expectedCameoMinutes = clamp(history.cameoMinutes ?? CAMEO_MINUTES[position], 1, 45)
expectedMinutes      = startProbability * expectedStartMinutes
                       + cameoProbability * expectedCameoMinutes
```

Position defaults (`lib/availability/selection.ts:45`):

| Position | START_MINUTES | CAMEO_MINUTES |
|---|---|---|
| GK | 90 | 5 |
| DEF | 84 | 14 |
| MID | 79 | 20 |
| FWD | 78 | 20 |

### 4.7 Nailed rating

`rating` (`lib/availability/selection.ts:164`) maps start probability to a 1–5 scale:

```
>= 0.85 → 5     >= 0.70 → 4     >= 0.45 → 3     >= 0.15 → 2     else → 1
```

### 4.8 Selection confidence

`confidence` (`lib/availability/selection.ts:172`):

- A RotoWire signal, a covered team, or `history.matches >= 10` → `HIGH`.
- Any history, current minutes, or a known `chanceOfPlaying` → `MEDIUM`.
- Otherwise → `LOW`.

---

## 5. Expected minutes (standalone)

`estimateExpectedMinutes` (`lib/projections/expectedMinutes.ts:76`) short-circuits before any of the formula below runs: if `player.selection` already exists and carries a finite `expectedMinutes`, that value is returned immediately (`lib/projections/expectedMinutes.ts:81`). `enrichPlayersWithHistory` always attaches a selection to every player before projecting, so in the enriched pipeline this function's own logic never actually executes - it exists for any caller that hands it a player without a selection model (for example, a hand-built player in a test), not as a live fallback within the app's own request path.

For such a player, without a selection:

```
prior  = history.minutes <= 0 ? 0 : 22 + clamp(starts / 38, 0, 1) * 60
recent = average recent minutes (current minutes / matches), adjusted by sub rate
weight = clamp(currentGameweek / 8, 0.15, 0.65)
estimate = prior * (1 - weight) + recent * weight
estimate *= statusAvailability(player)
```

`statusAvailability` (`lib/projections/expectedMinutes.ts:21`) mirrors `officialAvailability` (§4.4) exactly, so a player without a selection model is discounted identically to one with a selection model for the same underlying fact:

- Unavailable (`i`, `u`, `n`, `s`): `factor = 0.01`, then multiplied by `chanceOfPlaying / 100` when present.
- Doubtful (`d`): `factor = chanceOfPlaying / 100` directly when supplied, else `0.7`.
- Otherwise `factor = 1`.

---

## 6. Per-90 rates and regression

### 6.1 Rate extraction

`historicalRate` / `currentRate` (`lib/projections/projectPlayer.ts:49`) convert a raw count to a per-90 rate: `value / minutes * 90`.

### 6.2 Regression toward a prior

`regressPer90` (`lib/projections/regression.ts:2`):

```
rate = (observedPer90 * sampleMinutes + priorPer90 * 900) / (sampleMinutes + 900)
```

900 minutes (10 matches) is the prior weight: with no sample the prior wins; with a large sample the observed rate dominates.

### 6.3 Blending current + historical, then regressing

`regressedPlayerRate` (`lib/projections/projectPlayer.ts:78`) is used for bonus, saves, and defensive contributions:

```
rate   = historicalRate ?? prior
sample = historicalMinutes
if current exists:
    currentWeight = clamp(currentGameweek / 10, 0, 0.6)
    rate   = rate * (1 - currentWeight) + currentRate * currentWeight
    sample += currentMinutes * currentWeight
rate = clamp(regressPer90(rate, sample, prior, 900), 0, ceiling)
```

The current season earns up to 60% weight as the season progresses.

### 6.3.1 xG and xA: recency-weighted match history

xG and xA use a different current-season blend, `regressedFormRate` (`lib/projections/projectPlayer.ts:110`). A player's own historical (or position-prior) rate still anchors the blend - `basePrior = historicalRate ?? prior`, unchanged from §6.3 - but the current-season half comes from `blendPlayerRate` (`lib/projections/playerForm.ts:32`), a recency-weighted average of the player's own match-by-match xG/xA this season, rather than a flat season-to-date average:

```
weight(i matches before the most recently played) = decay^i
observedRate     = Σ(weight_i * matchRate_i) / Σ(weight_i)
effectiveMatches = Σ(weight_i)
blended          = (basePrior * priorWeightMatches + observedRate * effectiveMatches)
                   / (priorWeightMatches + effectiveMatches)
```

`decay = 0.95`, `priorWeightMatches = 10` (`PLAYER_FORM_DECAY`/`PLAYER_FORM_PRIOR_WEIGHT_MATCHES`, `lib/projections/playerForm.ts`) come from the 2025/26 walk-forward sweep in `scripts/backtest/evidence-weights.ts`. Decays 0.93-0.95 were effectively tied on actual-points RMSE and 0.95 won the main split. After 38 appearances the current season contributes 17.15 effective matches, or 63.2% of the blend against the ten-match historical anchor; after two appearances it contributes 1.95 effective matches, or 16.3%.

This only applies once a player has an in-season match history (`options.playerForm`, populated by `loadInSeasonPlayerRates` in `lib/historical/loadInSeasonForm.ts` from FPL's live per-gameweek stats, one entry per finished gameweek the player actually featured in). Before any gameweek has finished, or for a caller that hasn't wired up the loader, xG/xA fall back to the exact §6.3 mechanism (cumulative `Player.current.expectedGoals`/`expectedAssists`, blended by calendar gameweek and regressed toward the prior at a 900-minute weight) so behaviour degrades gracefully rather than silently discarding those live totals.

### 6.4 Priors and ceilings

Priors (`lib/projections/projectPlayer.ts:23`):

| Stat | GK | DEF | MID | FWD |
|---|---|---|---|---|
| xG prior | 0.01 | 0.08 | 0.25 | 0.45 |
| xA prior | 0.02 | 0.08 | 0.20 | 0.15 |
| Defensive contributions | 0 | 7.7 | 8.6 | 4.7 |
| Saves | 2.8 | 0 | 0 | 0 |
| Bonus | 0.22 | 0.22 | 0.32 | 0.59 |

A defender with no usable goal/assist sample uses a special low prior (`0.02` each) rather than the position prior.

Ceilings (`lib/projections/projectPlayer.ts:34`): goal involvement 3, saves 10, defensive contributions 30, bonus 3 (all per 90).

---

## 7. Fixture adjustment

`calculateFixtureAdjustment` (`lib/projections/fixtureAdjustment.ts:97`) returns one attacking multiplier and the fixture's clean-sheet pair (§7.5).

### 7.1 Base difficulty and venue

```
difficulty       = clamp(round(fixture.difficulty ?? 3), 1, 5)
base             = {1: 1.14, 2: 1.07, 3: 1.00, 4: 0.92, 5: 0.84}[difficulty]
venue            = home ? 1.102 : 0.898
attackMultiplier = base * venue
expectedGoalsAgainst = 1.35 * (home ? 0.9 : 1.1)    // fallback only - see §7.3
```

The venue pair is measured, not assumed. Across all 380 fixtures of 2025/26,
home sides averaged 1.551 xG and away sides 1.264, so against the 1.408 league
mean the multipliers are `1.102` and `0.898`; actual goals agree (1.453 against
1.203). The earlier `1.03 / 0.97` was about a third of the real spread, and
contradicted the `0.9 / 1.1` used on the goals-against side of the same fixture.
Re-derive with `npx tsx scripts/backtest/sweep.ts`.

In practice `base` moves far less than the table suggests: FPL only ever issued
difficulty 2, 3 or 4 to home sides across the 380 fixtures of the current
season, so `base` spans `1.07`-`0.92`, not `1.14`-`0.84`.

### 7.2 Strength-based adjustment

When both own and opponent team strengths exist:

```
attackMultiplier *= clamp(ownAttack / opponentDefence, 0.70, 1.35)
```

`cleanSheetProbability` is read from a market-calibrated table indexed by the nearest strength tier of the defending team and the opponent's attacking tier (see table in §7.4). Without strengths, `expectedGoalsAgainst` is divided by `base^2`.

The ratio window was `0.78`-`1.22`, which truncated a real signal: walk-forward
strengths for 2025/26 produced ratios from `0.47` to `1.62`, so the old clamp bit
on 24.5% of team-fixtures and could not tell a good matchup from a great one.
Widening it to `0.70`-`1.35` lowered expected-points RMSE by 0.0008 with the
paired confidence interval excluding zero, and won 24 of 33 gameweeks. The gain
is flat from there all the way to unclamped, so this is the narrowest window
that captures all of it - and a window is still wanted, because
`blendInSeasonForm` floors a defence ratio at `0.05`, which would let an
unclamped ratio reach about 25.

`attackMultiplier` is then clamped to `0.55`-`1.60`. That is deliberately wider
than the ratio window above, so the ratio clamp is the operative limit and this
only catches an absurd input.

It used to be `0.7`-`1.3`, which bound on 14% of forward-fixtures and did real
damage at the top. Over 2025/26 it flattened Erling Haaland's 30 fixtures onto a
`0.89`-`1.30` range when the inputs said `0.89`-`1.57`, with **11 of the 30
pinned on the ceiling** - so the model could not tell his best fixture from his
median one. Forwards' modelled swing between their easiest and hardest fixtures
came to 0.73 points against an observed 1.07.

This one is a calibration fix, not a measured accuracy win, and the difference
matters: widening the clamp left match-level RMSE unchanged (+0.0006, interval
spanning zero) and top-30 selection flat. Single-match points are too noisy to
reward getting the slope right. The case for it is that a ceiling erasing a
third of a player's fixture variation misleads anyone planning a fixture run.

### 7.3 Consistent goals-against

If no table lookup happened, the clean-sheet probability is `clamp(exp(-expectedGoalsAgainst), 0.03, 0.65)`. The goals-against number is then **re-derived from the clean-sheet probability** so both sources agree:

```
expectedGoalsAgainst = -ln(clamp(cleanSheetProbability, 0.03, 0.9))
```

This is the single Poisson parameter used by the goals-conceded deduction (§8).

### 7.4 Clean-sheet probability table

Rows are the defending team's tier; columns are the opponent's attacking tier (`lib/projections/fixtureAdjustment.ts:62`). Home first, then away:

| home | tier 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| tier 1 | 0.26 | 0.24 | 0.20 | 0.15 | 0.11 |
| tier 2 | 0.36 | 0.31 | 0.27 | 0.24 | 0.17 |
| tier 3 | 0.39 | 0.33 | 0.28 | 0.24 | 0.17 |
| tier 4 | 0.42 | 0.36 | 0.31 | 0.27 | 0.19 |
| tier 5 | 0.50 | 0.42 | 0.39 | 0.33 | 0.27 |

| away | tier 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| tier 1 | 0.23 | 0.16 | 0.15 | 0.12 | 0.06 |
| tier 2 | 0.31 | 0.25 | 0.20 | 0.17 | 0.11 |
| tier 3 | 0.33 | 0.27 | 0.22 | 0.18 | 0.13 |
| tier 4 | 0.36 | 0.30 | 0.25 | 0.21 | 0.15 |
| tier 5 | 0.42 | 0.35 | 0.34 | 0.30 | 0.18 |

Tiers are the `consensusStrengthTiers = [0.84, 0.92, 1.00, 1.08, 1.16]` mapped by nearest value.

Snapping a continuous strength to one of five anchors looks like it should cost
accuracy, and it does not. Walked forward over 660 team-fixtures of 2025/26, the
table scores a Brier of 0.1840 against 0.1907 for a constant league rate, with
the paired confidence interval excluding zero - so the table carries real signal.
Reading the same cells by bilinear interpolation scores 0.1839, and a continuous
Poisson lambda scores 0.1839-0.1847 across three scales and three exponents.
Every alternative sits inside the noise, and the Poisson was measurably *worse*
for MID/FWD once run through §8. The table stays. Re-run with
`npx tsx scripts/backtest/cleansheets.ts`.

Calibration by band is good at the top and soft at the bottom: the strongest
defences returned 0.326 clean sheets against 0.331 predicted, while the weakest
returned 0.152 against 0.208 predicted. The weak-defence row is the one worth
revisiting, not the resolution.

### 7.5 What section 7 returns

`attackMultiplier`, `cleanSheetProbability` and `expectedGoalsAgainst`, and
nothing else. A `defenceMultiplier`, an `overallMultiplier` and the
`fixtureAdjustment` / `fixtureMultiplier` / `adjustFixture` wrappers used to be
returned as well; none of them had a single consumer anywhere in the app, so
they were removed rather than documented. The component projection (§8) reads
the three remaining values directly.

---

## 8. Expected points (xP) components

`fixtureComponents` (`lib/projections/projectPlayer.ts:252`) computes the expected points for one fixture, decomposed into `ProjectionComponents` (`types/projection.ts:29`).

The selection model is reconstructed as scenarios (§4.5): a **start** scenario and a **cameo** scenario. For each scenario with `weight = probability` and `minutesShare = clamp(minutes, 0, 90) / 90`:

### 8.1 Appearance

```
appearance += weight * (minutes >= 60 ? 2 : 1)      // 1 for playing, 2 for 60+ min
```

### 8.2 Goals

```
goals += weight * xgRate * GOAL_CONVERSION[position] * minutesShare * attackMultiplier * GOAL_POINTS[position]
```

`GOAL_POINTS = { GK: 10, DEF: 6, MID: 5, FWD: 4 }`.

### 8.3 Assists

```
assists += weight * xaRate * ASSIST_CONVERSION[position] * minutesShare * attackMultiplier * 3
```

### 8.3.1 xG and xA are not goals and assists

Both rates are converted before they are paid, and the factor differs by
position. Measured over 2025/26 and cross-validated by gameweek:

| Position | goals per xG | assists per xA |
|---|---|---|
| GK | 1.000 | 1.000 |
| DEF | **0.700** | **1.272** |
| MID | 0.981 | **1.207** |
| FWD | 0.988 | **2.114** |

Two separate facts. A defender's chances are set-piece headers and convert at
0.70, where a midfielder or forward converts at essentially 1.0. And FPL is far
more generous with assists than xA is: it pays for the final pass whatever
happens to the shot, so a forward earns 2.11 assists per xA.

**What is deliberately not in this table.** A larger set of factors scores
better on the backtest (RMSE -0.0074 with the paired interval excluding zero,
against no measurable gain for the ones above). Those absorb a second effect -
the model overstating a midfielder's xG rate by 20% - and they are not shipped,
because `tests/core/calibration.test.ts` catches what they really are. Given
exact rates, they under-pay midfielders by 0.178 points and over-pay forwards by
0.215, pushing positional spread to 0.393 against a 0.35 guard. A rate error is
not a scoring rule and does not belong in one. The table above holds the guard
at 0.284.

That rate error is real and unfixed; §6.3.1 is where it lives. Shrinking a
player's own anchor toward the pool rate by its sample size was worth -0.0237
RMSE in testing - larger than anything else measured so far - but it barely
moves the bias, so the cause is regression to the mean rather than noise. It
remains open.

Re-derive any of this with `npx tsx scripts/backtest/fit-conversions.ts`.

### 8.4 Clean sheets

Only if the player reaches 60 minutes:

```
cleanSheets += weight * cleanSheetProbability * CLEAN_SHEET_POINTS[position]
```

`CLEAN_SHEET_POINTS = { GK: 4, DEF: 4, MID: 1, FWD: 0 }`.

### 8.5 Goals conceded (GK/DEF only)

One point is lost per two goals conceded while on the pitch. This is a threshold rule, so its expectation is summed over a Poisson count distribution rather than taken linearly (`expectedFloorDivision`, `lib/projections/distributions.ts:18`):

```
goalsConceded -= weight * E[ floor(expectedGoalsAgainst * minutesShare / 2) ]
```

where `E[floor(X / d)]` is computed over a `Poisson(expectedGoalsAgainst * minutesShare)` distribution.

### 8.6 Saves (GK only)

One point per three saves, again summed over the distribution:

```
savesEnvironment = clamp(expectedGoalsAgainst / 1.35, 0.7, 1.4)
saves += weight * E[ floor(savesRate * minutesShare * savesEnvironment / 3) ]
```

### 8.7 Defensive contributions

Two points once the count reaches a threshold (10 for DEF, 12 for MID/FWD, none for GK). The expectation is a probability, not a share:

```
defensiveContribution += weight * 2 * P(count >= threshold)
```

`P(count >= threshold)` uses a **negative binomial** (`thresholdProbability`, `lib/projections/distributions.ts:47`) with mean `defContRate * minutesShare` and `dispersion = 8`, because match-by-match contributions are more spread out than a Poisson allows.

### 8.8 Bonus

```
bonus += weight * bonusRate * minutesShare * attackMultiplier
```

Bonus follows the fixture. BPS is driven by the same goals, assists and clean
sheets §7 already adjusts, so a flat per-90 rate priced a player identically at
home to the worst defence and away to the best. Backtested over 2025/26: RMSE
-0.0033 for GK/DEF with the paired interval excluding zero, -0.0017 across all
rows. It also closes most of the gap in how far a forward's projection moves
between an easy and a hard fixture (0.73 to 1.01, against an observed 1.07).
The measured win is clearest for defenders, whose BPS owes more to clean sheets
and defensive actions than to their own team's attack - the multiplier is the
term that worked, not a claim about the mechanism.

### 8.9 Cards

```
yellowChance = 1 - exp(-yellowRate * minutesShare)
redChance    = 1 - exp(-redRate * minutesShare)
cards       -= weight * (1 * yellowChance + 3 * redChance)
```

A booking either happens or it does not, so this is a probability rather than a
rate times minutes - which also stops a full match implying more than one card.
Yellows and reds are added separately; a red arriving via a second yellow is
rare enough (0.005 per 90 at its highest) that the overlap is not modelled.

Rates are measured, not assumed. Across every 2025/26 appearance:

| Position | yellow / 90 | red / 90 | points per appearance |
|---|---|---|---|
| GK | 0.072 | 0.0013 | -0.076 |
| DEF | 0.182 | 0.0082 | -0.165 |
| MID | 0.188 | 0.0048 | -0.134 |
| FWD | 0.149 | 0.0000 | -0.088 |

League-wide that is **-0.135 points per appearance**, and it is differential: a
defender loses roughly twice what a forward does, so omitting cards flattered
defenders and held midfielders against the forwards they compete with. No
forward was sent off in the sample, so their red prior is a floor rather than
the observed zero.

Adding this term took overall bias from **+0.174 to +0.045** points per
appearance, and started midfielders from +0.175 to +0.001, measured with a
per-player anchor (`npx tsx scripts/backtest/anchor.ts`).

### 8.10 Total

`total` is the sum of all components. The `penalties` field exists in the type but is not populated (always 0).

---

## 9. Aggregation: nextGW, next3, next5, value

`projectPlayer` (`lib/projections/projectPlayer.ts:348`) projects every upcoming fixture (from `currentGameweek` out to `fixtureHorizon`, defaulting to the season's remaining weeks) and aggregates.

```
nextGW = sum of expectedPoints for fixtures in currentGameweek        (0 if blank)
next3  = sum over gameweeks [current, current+1, current+2]
next5  = sum over gameweeks [current, ..., current+4]
```

Aggregation is per **distinct gameweek** (`aggregateFixturePointsByGameweek`, `lib/projections/projectPlayer.ts:222`): a double gameweek sums all its fixtures, a blank gameweek contributes zero, and three/five-gameweek totals never double-count a fixture row.

```
valueNext5 = next5 / (priceTenths / 10)
```

`factors` (`lib/projections/projectPlayer.ts:314`) produces the display-only factor list (expected minutes, average fixture difficulty, confidence, position model).

---

## 10. Risk score

`calculateRiskScore` (`lib/projections/metrics.ts:26`):

```
minutesRisk      = expectedMinutes === undefined ? 25 : (90 - expectedMinutes) / 90 * 38
availabilityRisk = (1 - availability(player)) * 35
sampleRisk       = clamp(1 - sampleMinutes / 1800, 0, 1) * 17
confidenceRisk   = LOW ? 10 : MEDIUM ? 5 : 0
riskScore        = round(clamp(minutesRisk + availabilityRisk + sampleRisk + confidenceRisk, 0, 100))
```

`sampleMinutes` is `historical.minutes ?? current.minutes`. `availability` here is the simpler `availability` helper in `lib/projections/metrics.ts:7` (0.25 unavailable, 0.75 doubtful, else 1).

Higher is riskier. A score of 100 means: no projected minutes, fully unavailable, no sample, and low confidence.

---

## 11. Confidence

`projectionConfidence` (`lib/projections/metrics.ts:15`):

- If a selection model exists, use `selection.confidence` (§4.8).
- Otherwise: `available < 0.6` or `sample < 360` → `LOW`; `available < 0.85` or `sample < 900` or no history → `MEDIUM`; else `HIGH`.

`confidenceWeight` (`lib/analysis/context.ts:90`) converts confidence to a scalar: `HIGH → 1`, `MEDIUM → 0.85`, `LOW → 0.7`.

---

## 12. Value per million

`valuePerMillion` (`lib/projections/metrics.ts:44`):

```
valuePerMillion = projectedPoints / (priceTenths / 10)
```

---

## 13. Utility value

`utilityValue` (`lib/analysis/context.ts:111`) is the optimizer and analysis ranking scalar. It is *not* xP; it wraps xP with risk and confidence.

```
projection    = horizonValue(player, horizon)
minutes       = expectedMinutes(player) / 100
confidence    = confidenceWeight(projection.confidence)
availability  = 1 - availabilityRisk(player)
riskMultiplier= SAFE ? 0.72 : AGGRESSIVE ? 1.08 : 0.90
utility       = projection * (0.62 + 0.16*minutes + 0.12*confidence + 0.10*availability) * riskMultiplier
```

`availabilityRisk` (`lib/analysis/context.ts:94`) is its own helper: status `i`/`s` adds `0.75`, `d`/`u` adds `0.35`, and `chanceOfPlaying` adds `max(0, 1 - chance/100) * 0.65`, capped at 1.

---

## 14. Weekly lineup engine

`lib/squad/weeklyLineup.ts` owns the displayed weekly totals. Do not re-implement these in the UI.

### 14.1 Per-player weekly metrics

`basePoints` (`lib/squad/weeklyLineup.ts:58`) returns a player's points for one gameweek:

- If the player has fixture-level projections for that gameweek, sum their `expectedPoints` (blank gameweek returns 0).
- If the player has a fixture schedule but no entry for this gameweek, return 0 (never reuse `nextGW` from another week).
- Otherwise fall back to `projection.nextGW`, then to `pointsPer90 * minutes / 90`.

`minutes` (`lib/squad/weeklyLineup.ts:70`) sums fixture `expectedMinutes` (each clamped 0–90) for the gameweek.

### 14.2 Probability did not play (pDNP)

`probabilityDidNotPlay` (`lib/squad/weeklyLineup.ts:78`):

```
if (fixture schedule exists and no fixture this gameweek) → 1
if (fixtures exist but 0 minutes)                        → 1
availabilityRisk = unavailable status ? 1 : doubtful status ? 0.5 : 0
availabilityRisk = max(availabilityRisk, 1 - chanceOfPlaying/100)
if (availabilityRisk >= 1) → 1
minutesRisk = clamp((45 - minutes) / 45, 0, 1)
pDNP        = clamp(availabilityRisk * 0.75 + minutesRisk * 0.25, 0, 1)
```

### 14.3 Legal starting XIs

`enumerateLegalStartingXIs` (`lib/squad/weeklyLineup.ts:127`) enumerates every 11-player subset satisfying: 1 GK, ≥3 DEF, ≥2 MID, ≥1 FWD, and 10 outfield players. A malformed squad yields no candidates rather than corrupting state.

### 14.4 Selecting the XI and risk modes

Candidates are scored on `projectedXI` (sum of starter points), `risk` (sum of pDNP), and `minutes` (sum of minutes). A **near-equal window** of `0.25` points keeps candidates whose projected XI is within 0.25 of the best. The winner is chosen by `compareCandidates` (`lib/squad/weeklyLineup.ts:166`):

- `SAFE`: minimize total risk (pDNP).
- `BALANCED`: maximize total minutes.
- Then maximize projected XI, then risk, then minutes, then id (deterministic).

### 14.5 Bench order and autosubs

The four bench players are one GK plus three ordered outfield substitutes. `expectedAutosubValue` (`lib/squad/weeklyLineup.ts:242`) computes the expected points recovered by a bench order across all appearance masks:

- Goalkeeper: `P(starting GK out) * P(bench GK plays) * benchGK.points`.
- Outfield: for each starting/bench appearance state, substitutes play in bench order for absent starters **only where FPL formation rules still hold** (`legalFormation`), adding the substitute's points.

The bench order that maximizes this value wins.

### 14.6 Captain and vice-captain

`captainPair` (`lib/squad/weeklyLineup.ts:298`):

- Captain: the starter with the highest points (ties broken by lowest pDNP, then id).
- Vice-captain: the highest `points * (1 - pDNP)` among the rest.

### 14.7 Weekly totals

```
projectedXI   = sum of starter points
captainBonus  = captain's points                       (double-counts the captain)
autosubValue  = expected autosub value (§14.5)
projectedTotal = projectedXI + captainBonus + autosubValue
```

### 14.8 Projection fingerprint

`fingerprint` (`lib/squad/weeklyLineup.ts:269`) is an FNV-1a hash of the gameweek plus every player's `basePoints` and `pDNP` (to 3 decimals). A stale fingerprint on a persisted lineup produces a warning rather than a silent overwrite.

---

## 15. Squad analysis metrics

`lib/analysis/` builds summaries on top of the projections.

### 15.1 horizonValue

`horizonValue` (`lib/analysis/context.ts:67`) returns `projection.nextGW` / `next3` / `next5`; if absent it recomputes a projection, and if that is unavailable it falls back to `pointsPer90 * minutes / 90 * horizon`.

### 15.2 Fixture difficulty (normalized)

`fixtureDifficulty` (`lib/analysis/context.ts:104`):

```
avg = mean(fixture.difficulty ?? 3) over the first `horizon` fixtures
fixtureDifficulty = clamp((avg - 1) / 4, 0, 1)      // empty schedule → 0.5
```

### 15.3 Weakness score

`scoreWeakness` (`lib/analysis/weakness.ts:45`) compares a player to same-position peers. `percentileDeficit` is `1 - (#peers strictly below) / (peers.length - 1)`.

Components and weights:

| Component | Weight | Definition |
|---|---|---|
| projection | 30 | percentile deficit of `horizonValue` |
| value | 20 | percentile deficit of `horizonValue / price` |
| fixtures | 15 | `fixtureDifficulty` |
| minutes | 15 | `1 - expectedMinutes / 90` |
| availability | 12 | `availabilityRisk` |
| confidence | 8 | `1 - confidenceWeight(confidence)` |

`score = round(clamp(Σ component * weight, 0, 100))`. Higher means weaker.

### 15.4 Strengths

`buildStrengths` (`lib/analysis/analyzeSquad.ts:85`) surfaces: the share of the squad with `expectedMinutes >= 80` (≥70% is positive), a favourable average fixture run (`fixtureDifficulty <= 0.45`), and total projected points.

---

## 16. Transfer suggestions

### 16.1 Replacements

`findReplacements` (`lib/analysis/replacements.ts:169`) ranks same-position candidates by:

```
score = projectedDelta + (SAFE ? expectedMinutes / 100 : 0) + bankDelta / 100
```

where `projectedDelta = candidate.nextN - outgoing.nextN` and `bankDelta = outgoing.price - candidate.price`. Eligibility applies club limits, budget, exclusions, and (for SAFE) availability/confidence gates.

### 16.2 Single transfers

`findBestSingleTransfers` (`lib/analysis/singleTransfers.ts:92`) exhaustively evaluates every legal one-player swap that improves xP, keeping the Pareto frontier on (xP-per-gameweek, cash-released):

```
score = projectedDeltaPerGW + 0.25 * (cashReleasedTenths / 10)
```

A transfer is `XP_UPGRADE`, or `BOTH` when it also releases cash. Dominated moves are dropped.

### 16.3 Simulate a change

`simulateChange` (`lib/analysis/simulateChange.ts:50`) computes before/after squad analyses and, for legal full squads, uses the weekly lineup engine (§14) to produce optimized `projectedDeltaGW/3/5`.

---

## 17. Squad optimization

### 17.1 Objective

`objectiveScore` (`lib/optimizer/optimizer.ts:178`) scores a completed squad:

- Every starting XI player: full `utilityValue`.
- Backup GK: `utility * 0.05 - price / 20`.
- Outfield bench (ordered): `utility * {0.25, 0.15, 0.10}`.
- `+0.01` per HIGH-confidence starter (tie-break).
- `bench === CHEAP`: `-price / 10000` per bench player.
- `bench === STRONG`: `+utility * 0.04` per bench player.

The backup goalkeeper is biased toward the £4.0m tier (the `price / 20` penalty) without making incompatible locks an error.

### 17.2 Construction (beam search)

`beamConstruct` (`lib/optimizer/optimizer.ts:129`) grows a squad slot by slot with a beam of candidate states, pruning states that cannot afford a legal completion (`minimumCheapCost`, a lower bound on the remaining spend). Finalists are ranked by `objectiveScore`.

### 17.3 Exact optimizer

`exactOptimizer.ts` builds a mixed-integer program (HiGHS) with the same objective, adding per-gameweek captain variables so the captain's points are counted once more in the objective. `captainsByGameweek` reports the chosen captain per gameweek. This is the app-facing exact path.

---

## 18. Budget feasibility

`lib/squad/budget.ts` answers "can this partial squad still be completed within budget?"

- `minimumRemainingSpend` (`lib/squad/budget.ts:94`) runs an exact min-cost flow: each position sends its missing slots to distinct players, and each club caps total flow at three players. The cheapest completions per club are the only candidates considered, which is exact because no club can contribute more than three players.
- `calculateBudgetFeasibility` (`lib/squad/budget.ts:205`) returns spent, bank, minimum required spend, and flexible headroom (`bank - minimum`).
- `maxSafePriceForPosition` (`lib/squad/budget.ts:237`) returns the highest price that keeps the squad completable.
- `explainIllegalSelection` (`lib/squad/budget.ts:279`) explains the shortfall in pounds when an add breaks feasibility.

The analysis layer has a lighter-weight `cheapCompletionCost` (`lib/analysis/replacements.ts:95`) that approximates the same completion cost via depth-first search over the 12 cheapest players per position.

---

## 19. Constant tables

Team strength constants (`lib/historical/inSeasonForm.ts`):

| Constant | Value |
|---|---|
| Consensus tier → ratio | `0.76 + tier * 0.08` |
| In-season form decay (per match) | 0.90 |
| In-season form prior weight | 10 "matches worth" |
| xG floor (avoids divide-by-zero) | 0.15 |

Player form constants (`lib/projections/playerForm.ts`):

| Constant | Value |
|---|---|
| xG/xA in-season form decay (per match) | 0.90 |
| xG/xA in-season form prior weight | 24 "matches worth" |

Scoring constants (`lib/projections/projectPlayer.ts`):

| Rule | Value |
|---|---|
| Goal points | GK 10, DEF 6, MID 5, FWD 4 |
| Goals per xG | GK 1.000, DEF 0.700, MID 0.981, FWD 0.988 |
| Assists per xA | GK 1.000, DEF 1.272, MID 1.207, FWD 2.114 |
| Assist points | 3 |
| Clean sheet points | GK 4, DEF 4, MID 1, FWD 0 |
| Defensive contribution points | 2 (threshold GK 0, DEF 10, MID 12, FWD 12) |
| Saves per point | 3 |
| Goals-conceded deduction | 1 point per 2 goals |
| Card deductions | yellow 1, red 3 |
| Yellow prior per 90 | GK 0.072, DEF 0.182, MID 0.188, FWD 0.149 |
| Red prior per 90 | GK 0.001, DEF 0.008, MID 0.005, FWD 0.002 |

Fixture constants (`lib/projections/fixtureAdjustment.ts`):

| Constant | Value |
|---|---|
| League average goals against | 1.35 |
| Difficulty multipliers | 1→1.14, 2→1.07, 3→1.00, 4→0.92, 5→0.84 |
| Home / away attack venue | 1.102 / 0.898 (measured) |
| Attack ratio clamp | 0.70 – 1.35 |
| Attack multiplier clamp | 0.55 – 1.60 (backstop only) |
| Strength tier anchors | 0.84, 0.92, 1.00, 1.08, 1.16 |

Lineup constants (`lib/squad/weeklyLineup.ts`):

| Constant | Value |
|---|---|
| Near-equal XI window | 0.25 points |
| pDNP availability / minutes split | 0.75 / 0.25 |
| pDNP minutes knee | 45 minutes |

Optimizer constants (`lib/optimizer/optimizer.ts`):

| Constant | Value |
|---|---|
| Backup GK utility weight | 0.05 |
| Backup GK price divisor | 20 |
| Outfield bench utility weights | 0.25, 0.15, 0.10 |
