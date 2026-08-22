import type { Player, ProjectionConfidence } from "@/types/player";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function availability(player: Player): number {
  if (typeof player.chanceOfPlaying === "number") return clamp(player.chanceOfPlaying, 0, 100) / 100;
  const status = player.status.toLowerCase();
  if (/injur|suspend|unavail|out|not.?squad/.test(status) || ["i", "u", "n"].includes(status)) return 0.25;
  if (/doubt|knock|ill/.test(status) || status === "d") return 0.75;
  return 1;
}

export function projectionConfidence(player: Player): ProjectionConfidence {
  if (player.selection) return player.selection.confidence;
  const sample = player.historical?.minutes ?? player.current.minutes;
  const available = availability(player);
  if (available < 0.6 || sample < 360) return "LOW";
  if (available < 0.85 || sample < 900 || !player.historical) return "MEDIUM";
  return "HIGH";
}

export const calculateProjectionConfidence = projectionConfidence;

export function calculateRiskScore(
  player: Player,
  expectedMinutes?: number,
  confidence: ProjectionConfidence = projectionConfidence(player),
): number {
  const sample = player.historical?.minutes ?? player.current.minutes;
  const minutesRisk = expectedMinutes === undefined
    ? 25
    : clamp((90 - expectedMinutes) / 90, 0, 1) * 38;
  const availabilityRisk = (1 - availability(player)) * 35;
  const sampleRisk = clamp(1 - sample / 1800, 0, 1) * 17;
  const confidenceRisk = confidence === "LOW" ? 10 : confidence === "MEDIUM" ? 5 : 0;
  return Math.round(clamp(minutesRisk + availabilityRisk + sampleRisk + confidenceRisk, 0, 100));
}

export const riskScore = calculateRiskScore;

/** xPts per £m; prices are stored as integer tenths throughout the app. */
export function valuePerMillion(projectedPoints: number, priceTenths: number): number {
  return priceTenths > 0 ? projectedPoints / (priceTenths / 10) : 0;
}

export const calculateValue = valuePerMillion;
export const projectedValue = valuePerMillion;

export function percentile(value: number, values: readonly number[]): number {
  if (values.length === 0) return 0;
  const below = values.filter((candidate) => candidate <= value).length;
  return Math.round((below / values.length) * 100);
}
