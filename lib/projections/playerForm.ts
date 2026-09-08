export type { PlayerMatchRate } from "@/types/projection";

/**
 * The 2025/26 walk-forward sweep put decay 0.93-0.95 in the same xP RMSE
 * band; 0.95 won the main split. With ten matches of anchor weight, current
 * form reaches 63.2% of the blend after 38 appearances without discarding the
 * previous season. Re-run `scripts/backtest/evidence-weights.ts` to recalibrate.
 */
export const PLAYER_FORM_DECAY = 0.95;
export const PLAYER_FORM_PRIOR_WEIGHT_MATCHES = 10;

/**
 * Ratio cap on form rate relative to anchor. Capping form / anchor between
 * [anchor / 2.5, anchor * 2.5] takes rest-of-season rate RMSE from
 * 0.1908 to 0.1546 (movers: 0.2196 to 0.1644). Extreme divergences dominate
 * the sum of squares and revert hardest; winsorising prevents single-game
 * flukes from distorting multi-week projections.
 */
export const PLAYER_FORM_WINSOR_RATIO = 2.5;

/**
 * Blends a prior per-90 rate with a recency-weighted average of a player's
 * own match history. `historyRates` is this player's own per-90 rate for
 * this stat, one entry per match they featured in, oldest first. The most
 * recently played match gets the full weight; each match before that is
 * discounted by `decay` per match back, so recent matches count more
 * without a hard cutoff.
 *
 * `winsorRatio` bounds the observed rate to [prior / winsorRatio, prior * winsorRatio]
 * when prior > 0, shielding projections against extreme short-run volatility.
 */
export function blendPlayerRate(
  historyRates: readonly number[],
  prior: number,
  decay: number = PLAYER_FORM_DECAY,
  priorWeightMatches: number = PLAYER_FORM_PRIOR_WEIGHT_MATCHES,
  winsorRatio: number = PLAYER_FORM_WINSOR_RATIO,
): number {
  const n = historyRates.length;
  if (n === 0) return prior;
  let weightSum = 0;
  let weightedRate = 0;
  for (let i = 0; i < n; i += 1) {
    const rate = historyRates[n - 1 - i]; // i=0 is the most recently played match
    const weight = decay ** i;
    weightSum += weight;
    weightedRate += weight * rate;
  }
  const observedRate = weightedRate / weightSum;
  const effectiveMatches = weightSum;
  const cappedObservedRate = prior > 0 && winsorRatio > 0
    ? Math.min(Math.max(observedRate, prior / winsorRatio), prior * winsorRatio)
    : observedRate;
  return (prior * priorWeightMatches + cappedObservedRate * effectiveMatches) / (priorWeightMatches + effectiveMatches);
}

/** One match's contribution to a rate: the stat's raw value and the minutes it was earned in. */
export interface PlayerMatchSample {
  value: number;
  minutes: number;
}

/**
 * Prior weight for the components that carry rare events - cards above all.
 * A yellow card is a once-every-five-matches event, so a player's previous
 * season is worth roughly four times what it is worth for xG. Fitted on
 * 2023/24-2025/26 and checked by leaving each season out in turn: W 40 beat the
 * borrowed W 10 on all three held-out seasons (+2.7%, +10.9%, +4.3% RMSE).
 * Re-run `scripts/backtest/changes.mjs` to recalibrate.
 */
export const PLAYER_FORM_PRIOR_WEIGHT_RARE_EVENTS = 40;

/**
 * The minutes-weighted twin of `blendPlayerRate`, for when the caller has each
 * match's raw value rather than its per-90 rate.
 *
 * `blendPlayerRate` averages per-90 rates match by match, which gives an
 * eight-minute cameo the same say as a full ninety. That noise is large enough
 * that the previous season outscores the current one outright. Dividing the
 * decayed sum of values by the decayed sum of minutes fixes it: recency is
 * unchanged, but a cameo now carries a cameo's worth of evidence. Worth 2.0-6.3%
 * rest-of-season rate RMSE on xG across three held-out seasons, 1.1-1.4% on xA.
 *
 * The anchor's pull is deliberately still counted in matches, not minutes, so
 * `priorWeightMatches` keeps the meaning it has in `blendPlayerRate`.
 */
export function blendPlayerRateByMinutes(
  samples: readonly PlayerMatchSample[],
  prior: number,
  decay: number = PLAYER_FORM_DECAY,
  priorWeightMatches: number = PLAYER_FORM_PRIOR_WEIGHT_MATCHES,
  winsorRatio: number = PLAYER_FORM_WINSOR_RATIO,
): number {
  const n = samples.length;
  if (n === 0) return prior;
  let weightSum = 0;
  let weightedValue = 0;
  let weightedMinutes = 0;
  for (let i = 0; i < n; i += 1) {
    const sample = samples[n - 1 - i]; // i=0 is the most recently played match
    const weight = decay ** i;
    weightSum += weight;
    weightedValue += weight * sample.value;
    weightedMinutes += weight * sample.minutes;
  }
  if (weightedMinutes <= 0) return prior;
  const observedRate = (weightedValue / weightedMinutes) * 90;
  const effectiveMatches = weightSum;
  const cappedObservedRate = prior > 0 && winsorRatio > 0
    ? Math.min(Math.max(observedRate, prior / winsorRatio), prior * winsorRatio)
    : observedRate;
  return (prior * priorWeightMatches + cappedObservedRate * effectiveMatches) / (priorWeightMatches + effectiveMatches);
}
