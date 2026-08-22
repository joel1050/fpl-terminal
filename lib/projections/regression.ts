/** Shrinks a small-sample per-90 rate toward a stable prior. */
export function regressPer90(
  observedPer90: number,
  sampleMinutes: number,
  priorPer90: number,
  priorWeightMinutes = 900,
): number {
  const sample = Math.max(0, sampleMinutes);
  const weight = Math.max(0, priorWeightMinutes);
  if (sample + weight === 0) return priorPer90;
  return (observedPer90 * sample + priorPer90 * weight) / (sample + weight);
}

export const regressRate = regressPer90;
export const regressTowardsPrior = regressPer90;

export interface RegressionInput {
  rate: number;
  sampleMinutes: number;
  prior: number;
  priorWeightMinutes?: number;
}

export function regress(input: RegressionInput): number {
  return regressPer90(input.rate, input.sampleMinutes, input.prior, input.priorWeightMinutes);
}
