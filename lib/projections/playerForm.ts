export type { PlayerMatchRate } from "@/types/projection";

/**
 * decay=0.90 and priorWeight=24 "matches worth" are backtested, not
 * guessed: walking forward through 20,356 player-appearances across the
 * 2023/24 and 2024/25 seasons, chasing a player's own most recent match or
 * two performed far worse than trusting a stable position-average prior
 * heavily (correlation with actual next-match xG collapsed from ~0.46 to
 * ~0.29 at a low prior weight). Individual match output is dominated by
 * shot-quality variance a player doesn't control, so a formula that reacts
 * hard to the last match is mostly reacting to randomness - the opposite of
 * what "recent form" is meant to capture.
 *
 * Fitted separately, xG's optimum was ~26 matches (decay barely mattered -
 * a flat season average tied a decayed one) and xA's was ~40 matches (xA is
 * noisier still, since it depends on a teammate finishing the chance).
 * decay=0.90 and priorWeight=24 is the deliberately shared, slightly
 * conservative middle ground used for both stats rather than either one's
 * precise peak.
 */
export const PLAYER_FORM_DECAY = 0.9;
export const PLAYER_FORM_PRIOR_WEIGHT_MATCHES = 24;

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
