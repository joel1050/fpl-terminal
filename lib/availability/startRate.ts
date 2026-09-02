/**
 * Current-season start rate as an exponentially weighted update.
 *
 * The previous season sets the seed, then every completed fixture pulls the
 * estimate toward what actually happened:
 *
 *     p0 = previousSeasonStartRate
 *     pn = (1 - alpha) * p(n-1) + alpha * startedThisMatch
 *
 * Deliberately unlike `blendPlayerRate` and `blendInSeasonForm`, which weight
 * observed evidence by effective sample size. There is no shrinkage here and
 * that is the point: a role is a fact about the present, not an average over
 * the season, so the last match has to count for more than a match in GW1. A
 * 20% starter who starts five in a row reads 0.68, 0.87, 0.95, 0.98, 0.99, and
 * the same responsiveness detects a role being lost. Adding sample-size
 * weighting back would restore house idiom and destroy exactly that.
 *
 * ALPHA 0.40 is the fitted optimum from walk-forward multi-season sweeps
 * across 2023/24, 2024/25, and 2025/26 (scripts/backtest/start-rate-alpha.ts).
 * In all three seasons, alpha = 0.40 decisively beats 0.60 on both Brier score
 * (0.0936 vs 0.0966, 0.1039 vs 0.1101, 0.0940 vs 0.0973) and cuts log loss
 * by ~20% (0.42-0.47 against 0.53-0.58). It avoids the severe overconfidence
 * penalties of 0.60 while remaining responsive to role changes.
 */
export const START_RATE_ALPHA = 0.4;

/**
 * A start is 60 minutes played. Shared by the seed (`historicalSignal`), the
 * current-season loader, and the alpha sweep: the recursion's whole claim is
 * that its seed and its updates measure the same thing, so these three must
 * never drift apart.
 */
export const MINUTES_FOR_START = 60;

/** One observation per completed fixture, oldest first. */
export interface StartObservation {
  started: boolean;
  appeared: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function update(seed: number, observations: readonly boolean[], alpha: number): number {
  const rate = clamp(alpha, 0, 1);
  return observations.reduce(
    (previous, observed) => previous * (1 - rate) + (observed ? 1 : 0) * rate,
    clamp(seed, 0, 1),
  );
}

/** Start rate after applying every observation to a previous-season seed. */
export function blendStartRate(
  previousSeasonStartRate: number,
  observations: readonly StartObservation[],
  alpha: number = START_RATE_ALPHA,
): number {
  return update(previousSeasonStartRate, observations.map((item) => item.started), alpha);
}

/**
 * Cameo rate implied by the same recursion run on appearances.
 *
 * Running cameo as its own independent EWMA would let it drift out of step
 * with starts: a player dropped from the squad would fall to a 0.02 start
 * rate while still carrying a stale 0.30 cameo rate, reading as "regular
 * substitute" when he is not in the squad at all. Deriving it from the gap
 * between appearing and starting keeps the two consistent by construction.
 */
export function blendCameoRate(
  previousSeasonStartRate: number,
  previousSeasonCameoRate: number,
  observations: readonly StartObservation[],
  alpha: number = START_RATE_ALPHA,
): number {
  const appearanceSeed = clamp(previousSeasonStartRate + previousSeasonCameoRate, 0, 1);
  const appeared = update(appearanceSeed, observations.map((item) => item.appeared), alpha);
  const started = blendStartRate(previousSeasonStartRate, observations, alpha);
  return clamp(appeared - started, 0, 1);
}
