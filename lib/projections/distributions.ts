/**
 * Discrete helpers for FPL's threshold scoring rules.
 *
 * Several FPL rules pay on a count crossing a line rather than on the count
 * itself: two points once a defender records ten defensive contributions, one
 * point per three saves, minus one per two goals conceded. The expectation of
 * such a rule is not a linear function of the mean, so each one is summed over
 * the count distribution instead.
 */

const MAX_TERMS = 40;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Expected value of `floor(X / divisor)` for a Poisson-distributed count. */
export function expectedFloorDivision(mean: number, divisor: number): number {
  if (!Number.isFinite(mean) || mean <= 0 || divisor <= 0) return 0;
  let probability = Math.exp(-mean);
  let total = 0;
  for (let count = 0; count < MAX_TERMS; count += 1) {
    total += probability * Math.floor(count / divisor);
    probability *= mean / (count + 1);
  }
  return total;
}

/** Poisson probability of exactly `count` events. */
export function poissonProbability(mean: number, count: number): number {
  if (mean <= 0) return count === 0 ? 1 : 0;
  let probability = Math.exp(-mean);
  for (let step = 0; step < count; step += 1) probability *= mean / (step + 1);
  return probability;
}

/**
 * Probability that a count reaches `threshold`, under a negative binomial with
 * `variance = mean + mean^2 / dispersion`.
 *
 * Match-by-match defensive contributions are more spread out than a Poisson
 * allows, so a dispersion term is needed. The default is an assumption, not a
 * fitted value: `historical-match-stats.json` records only season totals, so
 * there is nothing to fit it against yet. Widening that ingest to per-match
 * counts would let this be measured directly.
 */
export function thresholdProbability(mean: number, threshold: number, dispersion = 8): number {
  if (!Number.isFinite(mean) || mean <= 0) return 0;
  if (threshold <= 0) return 1;
  const shape = Math.max(dispersion, 0.1);
  const success = shape / (shape + mean);
  let term = Math.pow(success, shape);
  let below = 0;
  for (let count = 0; count < threshold; count += 1) {
    below += term;
    term *= ((shape + count) / (count + 1)) * (1 - success);
  }
  return clamp(1 - below, 0, 1);
}
