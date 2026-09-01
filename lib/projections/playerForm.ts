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
 * Blends a prior per-90 rate with a recency-weighted average of a player's
 * own match history. `historyRates` is this player's own per-90 rate for
 * this stat, one entry per match they featured in, oldest first. The most
 * recently played match gets the full weight; each match before that is
 * discounted by `decay` per match back, so recent matches count more
 * without a hard cutoff.
 */
export function blendPlayerRate(
  historyRates: readonly number[],
  prior: number,
  decay: number = PLAYER_FORM_DECAY,
  priorWeightMatches: number = PLAYER_FORM_PRIOR_WEIGHT_MATCHES,
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
  return (prior * priorWeightMatches + observedRate * effectiveMatches) / (priorWeightMatches + effectiveMatches);
}
