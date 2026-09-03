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
- **Horizons** are `1 | 3 | 5 | 10` gameweeks, counting *distinct* gameweeks (see §9).

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

### 3.3 In-season form (schedule-adjusted, recency-weighted xG)

Once matches are played, `applyInSeasonForm` (`lib/historical/inSeasonForm.ts:102`) blends the §3.1-3.2 prior with each team's own recent process, using **expected goals (xG)**, not goals scored and not win/draw/loss. A backtest across the 2023/24 and 2024/25 seasons found goals and win/draw/loss both perform *worse* than never updating the prior at all (goals are dominated by finishing variance; win/draw/loss collapses attack and defence into one undifferentiated signal); xG clearly improved clean-sheet prediction (AUC) and goals-scored correlation in both seasons individually.

To prevent soft or brutal fixture runs from biasing a team's emerging ratings, each past match's xG is **schedule-adjusted** by the opponent's prior strength when known:
- $\text{adjXgFor}_i = \text{xgFor}_i \times \text{oppPrior.defence}$: creating 1.5 xG against a stout 1.25 defence is valued higher ($1.875$) than against an anemic 0.80 defence ($1.20$).
- $\text{adjXgAgainst}_i = \text{xgAgainst}_i / \text{oppPrior.attack}$: conceding 1.0 xG to a potent 1.25 attack is forgiven down to $0.80$, while conceding 1.0 xG to a weak 0.80 attack is penalized up to $1.25$.

Each finished match contributes a weight that decays with recency, so recent matches dominate without a hard cutoff (`blendInSeasonForm`, `lib/historical/inSeasonForm.ts:43`):

```
weight(i matches before the most recent)  = decay^i
weightedXgFor      = Σ(weight_i * adjXgFor_i) / Σ(weight_i)
weightedXgAgainst  = Σ(weight_i * adjXgAgainst_i) / Σ(weight_i)
observedAttack     = weightedXgFor / leagueAverageXg
observedDefence    = leagueAverageXg / max(weightedXgAgainst, 0.15)     // inverted: fewer conceded = higher
currentShare       = matchesPlayed / (matchesPlayed + 12)
blended            = prior * (1 - currentShare) + observed * currentShare
```

`decay = 0.90` controls recency inside the current-season xG estimate. Its share of team strength grows separately as `n / (n + 12)`, so it is 50% after 12 matches, 65.7% after 23, and 76% after 38 instead of being capped by the decay window's effective sample size. The blend stays venue-agnostic like the prior: a venue-split variant (separate home/away xG streams) was tested and rejected because splitting an already-thin sample by venue adds noise faster than it adds signal.

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

This is the **seed only**. It is then updated by this season's own team sheets (§4.1.1).

### 4.1.1 Current-season update

`blendStartRate` (`lib/availability/startRate.ts`) runs the previous-season rate forward through every completed fixture:

```
p0 = previousSeasonStartRate            // §4.1, or the §4.2 fallback
pn = (1 - alpha) * p(n-1) + alpha * startedThisMatch
```

`START_RATE_ALPHA = 0.40`. A 20% starter who starts five in a row reads 52.0%, 71.2%, 82.7%, 89.6%, 93.8%; the same responsiveness catches a role being lost, while avoiding the severe overconfidence penalties of higher alphas.

Unlike `blendPlayerRate` (§6.3.1) and `blendInSeasonForm` (§5.2), there is **no sample-size shrinkage**. That is deliberate. A role is a fact about the present, not an average over the season, and effective-match weighting would destroy exactly the responsiveness the model exists for.

Cameo is derived, not run independently: `cameo = clamp(pAppeared - pStart, 0, 1)`, where `pAppeared` is the same recursion over `minutes > 0` seeded at `startRate + cameoRate`. Running it as a separate EWMA let a dropped player read as a 0.02 starter still carrying a 0.30 cameo rate - "regular substitute" for a player out of the squad.

**Observations** come from `loadInSeasonStarts` (`lib/historical/loadInSeasonForm.ts`), one row per eligible gameweek per player on an eligible team:

- A start is `minutes >= 60`, matching the seed's definition. FPL's per-match `starts` flag is more exact, but a seed and an update that disagree about what they measure are worse than a uniformly approximate pair.
- Zero-minute players **are** recorded, as `{started: false, appeared: false}`. This is the one shape difference from `loadInSeasonPlayerRates`, which drops them, and it carries the whole feature: without the zero rows a player who loses his place simply stops being updated and stays nailed. Hence a parallel loader and its own `in-season-starts-gw-N` snapshot key rather than an extra field on the rates loader, which would silently rebase the xG/xA blend behind `PLAYER_FORM_DECAY`.
- Eligibility is shared with the xG loaders, so **double gameweeks contribute nothing** and a **blank gameweek is no observation** rather than a benching.

Zero minutes is ambiguous - benched, rotated, injured, suspended and unregistered all look identical - so a layoff reads as role loss and a returning player needs about five matches to recover. In practice RotoWire naming him in the XI gives `0.9 x 0.75 = 0.675` whatever the recursion says, and the §4.4 hard gate handles the absence itself.

Backtested in `scripts/backtest/start-rate-alpha.ts` across 2023/24, 2024/25, and 2025/26 walk-forward. Alpha = 0.40 decisively beats 0.60 across all three seasons on Brier score (0.0936 vs 0.0966, 0.1039 vs 0.1101, 0.0940 vs 0.0973) and cuts log loss by ~20% (0.42-0.47 against 0.53-0.58).

### 4.2 Fallbacks

When there is no historical sample (`lib/availability/selection.ts:102`):

```
fallbackStartRate = current.minutes <= 0 ? 0.15 : clamp(0.1 + minutes / 1800, 0.15, 0.8)
fallbackCameoRate = current.minutes > 0 ? 0.12 : 0.08
```

For a player with **no previous season at all** — a promoted club's squad or a new signing — the seed is a flat `0.15` start / `0.08` cameo (`UNKNOWN_START_SEED = 0.15`, `UNKNOWN_CAMEO_SEED = 0.08`, `lib/availability/selection.ts:126`) once this season has match observations (`observations.length > 0`), rather than `fallbackStartRate`. The fallbacks read `player.current.minutes`, which is the running total the recursion is about to replay match by match; seeding from it would count this season twice at two different speeds. The `fallbackStartRate` terms still apply when there are zero current-season observations, where they are the only evidence there is.

### 4.3 Blending

```
seedWeight = observations.length > 0 ? 0 : 0.25
start      = historicalStart * (1 - seedWeight) + fallbackStartRate * seedWeight
cameo      = historicalCameo * (1 - seedWeight) + fallbackCameoRate * seedWeight
```

The `0.25` fallback term applies only while the player has no current-season observations (`observations.length === 0`). It existed to temper an estimate whose sole evidence was last season; once this season's own matches are in the estimate that term only dilutes them, since `fallbackStartRate` is clamped to 0.15–0.80 and would drag a measured 0.99 down to 0.94 and push a measured 0.02 up to 0.05.

If the player's team is covered by RotoWire, the RotoWire signal dominates:

```
rotowireStart = starter ? (confirmed ? 0.96 : 0.90) : 0.10
rotowireCameo = starter ? 0.05 : 0.12
start         = rotowireStart * 0.75 + historicalStart * 0.25
cameo         = rotowireCameo * 0.75 + historicalCameo * 0.25
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

`confidence` (`lib/availability/selection.ts:205`):

- A RotoWire signal, a covered team, `history.matches >= 10`, or `observations.length >= 5` → `HIGH`.
- Any history (`history.matches > 0`), any current-season observation (`observations.length > 0`), current minutes (`player.current.minutes > 0`), or a known `chanceOfPlaying` → `MEDIUM`.
- Otherwise → `LOW`.

Five matches take the EWMA most of the way from its seed to what this season says, so by then the estimate rests on observed starts rather than on last season's rate.

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

This only applies once a player has an in-season match history (`options.playerForm`, populated by `loadInSeasonPlayerRates` in `lib/historical/loadInSeasonForm.ts` from FPL's live per-gameweek stats, one entry per finished gameweek the player actually featured in). Before any gameweek has finished, or for a caller that hasn't wired up the loader, xG/xA fall back to the §6.3 mechanism (cumulative `Player.current.expectedGoals`/`expectedAssists`, blended by calendar gameweek and regressed toward the prior at a 900-minute weight), normalized by `ownAttack` when team strengths are present so elite attacking teams are not double-counted before match form accumulates.

### 6.3.2 Schedule adjustment: counting the fixture once

A match played against a weak defence produced a higher rate *for that reason*,
and §7's multiplier for the upcoming fixture is about to be applied on top. Left
alone, fixture quality is counted twice. `regressedFormRate`
(`lib/projections/projectPlayer.ts:150`) divides it back out before blending:

```
m_i        = attackMultiplier(opponent_i, venue_i)      // base = 1; see below
ownAttack  = (own.attackHome + own.attackAway) / 2
rate       = blendPlayerRate(matchRate_i / m_i, basePrior / ownAttack)
```

Both halves are normalized together. Normalizing the form alone leaves an
inflated anchor against a deflated form estimate, and scores worse than doing
nothing in every season tested.

`m_i` uses the *current* strength table and leaves `base` at 1, because neither
a past gameweek's strengths nor its difficulty is stored - only the opponent and
the venue, which `loadInSeasonPlayerRates` attaches to each appearance from the
fixture list. Both approximations were measured rather than assumed: scoring
past matches with today's strengths is *better* than the walk-forward version,
and the asymmetry against a live-FDR upcoming fixture costs 0.001-0.003 RMSE and
does not move the bias.

Any appearance without an opponent, or against a team with no strength entry,
drops the whole player back to the unadjusted blend rather than mixing scales.

**What it buys.** Backtested over 2022/23-2025/26. RMSE is a wash - the mean
prediction gap between arms is 0.016-0.026 xGI/90 against a residual of
0.17-0.25, so the test cannot resolve it. Bias is where it lands: the absolute
bias falls in 7 of 8 season-metric comparisons. Sorting started rows by the mean
multiplier their form window was played under, the unadjusted model's bias rises
monotonically across all five quintiles in all four seasons - it over-projects a
player coming off a soft run and under-projects one off a hard run. The
head-to-tail gradient falls from +0.164, +0.078, +0.098 and +0.092 xGI/90 to
+0.033, -0.041, -0.004 and -0.011.

**What it does not fix.** Splitting that gradient shows most of it is not the
schedule. Bucketed by a player's recent run against *his own* baseline the tilt
is mixed; bucketed by team level it is monotone in every season. A player's own
xG rate already carries his team's attacking quality and §7 applies that quality
again, so players on the strongest attacks are over-projected by roughly
0.05-0.09 xGI/90. Dividing the anchor by `ownAttack` removes part of that as a
side effect, which is why this arm beats the schedule-only one. The remainder
wants a share decomposition - player rate = team rate x player share, with the
multiplier scaling only the team half - which is not implemented.

Re-run with `npx tsx scripts/backtest/schedule-adjust.ts`.

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

**`base` and the strength ratio are not the same signal.** Both encode "how hard
is this fixture", so multiplying them looks like counting the opponent twice.
Measured over 2022/23-2025/26, it is not: their correlation is only 0.19-0.63,
and they point opposite ways on 9.5-30.6% of team-fixtures. Regress a team's
actual xG on the strength ratio and the residual still moves with `base`
(correlation 0.055, 0.071, 0.089 and 0.157 by season), so FPL's rating carries
information the model's own strengths miss. Dropping `base` whenever strengths
exist raises team-xG RMSE in all four seasons and is worse on xP in roughly 61%
of gameweeks; the xP difference resolves in 2022/23 alone (+0.0042, interval
excluding zero) and spans zero in the other three. **Keep both.** Re-run with
`npx tsx scripts/backtest/fdr.ts`.

What that leaves open is the *weighting*, not the inputs. Two partially
correlated signals are currently combined by plain multiplication, which is an
assumption rather than a fit, and no arm has yet tested a weighted blend.

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

Tiers are anchored at `consensusStrengthTiers = [0.84, 0.92, 1.00, 1.08, 1.16]` with `TIER_STEP = 0.08`.

Rather than snapping continuous team strength ratios onto discrete integer tiers, `interpolatedCleanSheet` evaluates a **2D bilinear interpolation** across the matrix:
```
r = clamp((ownDefence - 0.84) / 0.08, 0, 4)
c = clamp((opponentAttack - 0.84) / 0.08, 0, 4)
```
This produces smooth, continuous probability transitions as team form shifts throughout the season, eliminating artificial jump discontinuities while preserving exact values on integer tier coordinates. In walk-forward testing over 660 team-fixtures, continuous bilinear interpolation lowers clean sheet Brier score to 0.18469 and logloss to 0.55321 (vs 0.18527 and 0.55452 for discrete snapping). When combined with schedule-adjusted team form (§3.3), this lowered walk-forward xP RMSE to 2.69866 (-0.00162 vs discrete baseline, winning 19 of 33 gameweeks).

Reads above the long-run clean-sheet rate (0.25) are compressed one-sided toward it, retaining 75% of the excess (`CLEAN_SHEET_RETAINED_WEIGHT`, `lib/projections/fixtureAdjustment.ts`). The table's top quintile over-projected defender clean-sheet-plus-conceded points by +0.20 per appearance over 2023/24-2024/25 while the bottom two quintiles calibrated, so the bottom is left alone; weights 0.70-0.90 all beat the unshrunk table on team-level Brier in both seasons. Full-xP dRMSE -0.00163 with the paired gameweek-cluster interval excluding zero.

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

## 9. Aggregation: nextGW, next3, next5, next10, value

`projectPlayer` (`lib/projections/projectPlayer.ts:477`) projects every upcoming fixture (from `currentGameweek` out to `fixtureHorizon`, defaulting to the season's remaining weeks) and aggregates.

```
nextGW = sum of expectedPoints for fixtures in currentGameweek        (0 if blank)
next3  = sum over gameweeks [current, current+1, current+2]
next5  = sum over gameweeks [current, ..., current+4]
next10 = sum over gameweeks [current, ..., current+9]
```

Aggregation is per **distinct gameweek** (`aggregateFixturePointsByGameweek`, `lib/projections/projectPlayer.ts:400`): a double gameweek sums all its fixtures, a blank gameweek contributes zero, and multi-gameweek totals never double-count a fixture row.

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

`windowUtility` (`lib/analysis/context.ts:144`) evaluates utility for an explicit planning window `[gameweek, gameweek + horizon - 1]` rather than always starting from the live gameweek:

```
windowValue   = sum over g in [gameweek, ..., gameweek + horizon - 1] of gameweekValue(player, g)
windowUtility = windowValue * utilityScale(player, risk)
```

where `gameweekValue` returns fixture-projected points for that specific gameweek (double gameweeks sum, blank gameweeks score zero). This allows multi-gameweek planning snapshots and the exact optimizer to score upcoming gameweeks accurately.

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

### 15.5 Team rating

`teamRating` measures the quality of a starting lineup against the theoretical market ceiling for the same squad budget:

```
lineupXp   = currentGWPlan.projectedXI + currentGWPlan.captainBonus
teamRating = clamp(round(lineupXp / bestPossibleXI.projectedTotal * 100), 0, 100)
```

where `bestPossibleXI` is computed by `exactBestPossibleXI` (`lib/optimizer/bestPossibleXI.ts`, via `/api/best-xi`). It solves an exact MILP using HiGHS for the highest-scoring legal starting XI that the entire player universe could field within the team's `budgetTenths` and club limits (max 3/club), scoring players using the exact same weekly lineup metric (`weeklyPlayerMetrics(player, gameweek).points`) and captain bonus without bench or autosub on either side.

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

`objectiveScore` (`lib/optimizer/optimizer.ts:181`) scores a completed squad in the heuristic beam search:

- Every starting XI player: full `utilityValue`.
- Backup GK: `utility * 0.05 - price / 20`.
- Outfield bench (ordered): `utility * {0.25, 0.15, 0.10}`.
- `+0.01` per HIGH-confidence starter (tie-break).
- `bench === CHEAP`: `-price / 10000` per bench player.
- `bench === STRONG`: `+utility * 0.04` per bench player.

The backup goalkeeper is biased toward the £4.0m tier (the `price / 20` penalty) without making incompatible locks an error.

### 17.2 Construction (beam search)

`beamConstruct` (`lib/optimizer/optimizer.ts:129`) grows a squad slot by slot with a beam of candidate states, pruning states that cannot afford a legal completion (`minimumCheapCost`, a lower bound on the remaining spend). Finalists are ranked by `objectiveScore`.

### 17.3 Exact optimizer (HiGHS MILP)

`exactOptimizeFullSquad` and `exactCompletePartialSquad` (`lib/optimizer/exactOptimizer.ts:60`) formulate and solve an exact Mixed Integer Linear Program via HiGHS WebAssembly. The squad is planned for `planGameweek` across `horizon` (1, 3, 5, or 10 gameweeks), scoring players with `windowUtility(player, planGameweek, horizon, risk)` (§13):

1. **Decision variables**:
   - Squad membership: $x_i \in \{0, 1\}$
   - Starting XI: $s_i \in \{0, 1\}$
   - Backup goalkeeper: $g_i \in \{0, 1\}$
   - Ordered outfield bench slots: $b_{1, i}, b_{2, i}, b_{3, i} \in \{0, 1\}$
   - Weekly captaincy: $c_{g, i} \in \{0, 1\}$ for each gameweek $g \in [\text{planGameweek}, \dots, \text{planGameweek} + \text{horizon} - 1]$

2. **Objective terms**:
   - Starter utility: $s_i \times (u_i + 0.01 \times \mathbb{I}_{\text{HIGH}})$
   - Backup GK: $g_i \times (u_i \times 0.05 - \text{priceTenths}_i / 20 - \text{cheapPenalty} + \text{strongBonus})$
   - Bench slot $k \in \{1, 2, 3\}$: $b_{k, i} \times (u_i \times w_k - \text{cheapPenalty} + \text{strongBonus})$ with weights $w = [0.25, 0.15, 0.10]$
   - Captaincy: $c_{g, i} \times (\text{gameweekValue}(i, g) \times (u_i / \text{windowValue}_i))$
   - **Bench strategies**:
     - `bench === "CHEAP"`: $\text{cheapPenalty} = \text{priceTenths}_i \times 0.025 \times \text{horizon}$ (`CASH_XP_PER_TENTH_PER_GAMEWEEK = 0.025`, i.e. £0.25m xP/tenth/GW). The penalty scales with the horizon so the bench penalty competes proportionally with multi-gameweek starter utility.
     - `bench === "STRONG"`: $\text{strongBonus} = u_i \times 0.04$ (`BENCH_STRENGTH_BONUS = 0.04`).

3. **Constraints**:
   - Assignment: $s_i + g_i + b_{1, i} + b_{2, i} + b_{3, i} = x_i$
   - Squad counts: $\sum x_i = 15$, $\sum s_i = 11$, $\sum g_i = 1$, $\sum b_{k, i} = 1$ ($k \in \{1, 2, 3\}$)
   - Budget: $\sum \text{priceTenths}_i x_i \le \text{budgetTenths}$
   - Position legality: 2 GK, 5 DEF, 5 MID, 3 FWD in squad; starting formation requires 1 GK, $\ge 3$ DEF, $\ge 2$ MID, $\ge 1$ FWD
   - Club limit: $\sum_{i \in \text{club}} x_i \le 3$ (or configured max)
   - Locked players: $x_i = 1$ for all fixed/locked player IDs
   - Captaincy legality: $c_{g, i} \le s_i$ (captain must be in the starting XI), and $\sum_i c_{g, i} = 1$ for each gameweek

### 17.4 Best possible XI (market ceiling)

`exactBestPossibleXI` (`lib/optimizer/bestPossibleXI.ts:64`) solves a MILP for the highest-scoring legal 11-player starting XI that the entire player universe could field within the team's `budgetTenths` and club limits ($\le 3$ per club):

- Evaluates each player with `weeklyPlayerMetrics(player, gameweek).points`.
- Selects 11 starters ($1 \text{ GK}, \ge 3 \text{ DEF}, \ge 2 \text{ MID}, \ge 1 \text{ FWD}$, max 1 GK) and 1 captain ($c_i \le s_i$, $\sum c_i = 1$).
- Maximizes starting XI points plus captain bonus without bench or autosub mechanics.
- Used as the theoretical denominator in `teamRating` (§15.5).

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
| In-season form prior weight | 12 (`n / (n + 12)`) |
| xG floor (avoids divide-by-zero) | 0.15 |

Player form constants (`lib/projections/playerForm.ts`):

| Constant | Value |
|---|---|
| xG/xA in-season form decay (per match) | 0.95 |
| xG/xA in-season form prior weight | 10 "matches worth" |

Start rate and availability constants (`lib/availability/startRate.ts`, `lib/availability/selection.ts`):

| Constant | Value |
|---|---|
| Start rate update alpha (`START_RATE_ALPHA`) | 0.40 |
| Threshold minutes for start (`MINUTES_FOR_START`) | 60 |
| Unknown start seed without history (`UNKNOWN_START_SEED`) | 0.15 |
| Unknown cameo seed without history (`UNKNOWN_CAMEO_SEED`) | 0.08 |
| RotoWire predicted XI floor | 0.62 |
| RotoWire confirmed XI floor | 0.80 |
| Seed weight with zero observations | 0.25 |

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

Optimizer constants (`lib/optimizer/exactOptimizer.ts`, `lib/optimizer/optimizer.ts`):

| Constant | Value |
|---|---|
| Backup GK utility weight | 0.05 |
| Backup GK price divisor | 20 |
| Outfield bench utility weights | 0.25, 0.15, 0.10 |
| Cash xP per tenth per gameweek (`CASH_XP_PER_TENTH_PER_GAMEWEEK`) | 0.025 (£0.25m xP/tenth/GW) |
| Bench strength bonus (`BENCH_STRENGTH_BONUS`) | 0.04 |
| High-confidence starter bonus (tie-break) | 0.01 |
