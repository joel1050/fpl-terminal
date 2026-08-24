import type { EntryPicks } from "@/types/leagues";
import { effectiveMultipliers } from "./calculateLiveEntry";

/**
 * Average multiplier the sampled league managers hold on a player. Managers
 * without the player contribute 0, so the divisor is the whole sample.
 */
export function leagueAverageMultiplier(
  memberPicks: readonly EntryPicks[],
  playerId: number,
): number {
  if (!memberPicks.length) return 0;
  const total = memberPicks.reduce((sum, picks) => sum + (effectiveMultipliers(picks).get(playerId) ?? 0), 0);
  return total / memberPicks.length;
}

export function roundImpact(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The user's edge over the selected league on one scoring event: the raw FPL
 * points delta scaled by how much stronger the user's multiplier is than the
 * league average.
 */
export function relativeLeagueImpact(
  rawPointsDelta: number,
  userMultiplier: number,
  averageMultiplier: number,
): number {
  return roundImpact(rawPointsDelta * (userMultiplier - averageMultiplier));
}
