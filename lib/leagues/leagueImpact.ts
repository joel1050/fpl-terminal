import type { EntryPicks } from "@/types/leagues";
import { effectiveMultipliers } from "./calculateLiveEntry";

export interface PlayerOwnership {
  /** Sampled managers fielding the player, bench excluded. */
  owners: number;
  /** Their multipliers added up, so the average is one division away. */
  totalMultiplier: number;
}

export interface LeagueOwnership {
  /** Managers whose picks were actually loaded, which is the divisor. */
  sampleSize: number;
  /** True when the sample is the whole league rather than its top rows. */
  complete: boolean;
  byPlayer: ReadonlyMap<number, PlayerOwnership>;
}

export const EMPTY_LEAGUE_OWNERSHIP: LeagueOwnership = {
  sampleSize: 0,
  complete: false,
  byPlayer: new Map(),
};

/**
 * Reads every sampled manager's squad once, rather than once per player asked
 * about: a Gameweek's worth of feed rows against a full league would otherwise
 * rebuild the same multipliers tens of thousands of times per render.
 */
export function buildLeagueOwnership(
  memberPicks: readonly EntryPicks[],
  complete: boolean,
): LeagueOwnership {
  const byPlayer = new Map<number, PlayerOwnership>();
  for (const picks of memberPicks) {
    for (const [playerId, multiplier] of effectiveMultipliers(picks)) {
      if (multiplier <= 0) continue;
      const existing = byPlayer.get(playerId);
      if (existing) {
        existing.owners += 1;
        existing.totalMultiplier += multiplier;
      } else {
        byPlayer.set(playerId, { owners: 1, totalMultiplier: multiplier });
      }
    }
  }
  return { sampleSize: memberPicks.length, complete, byPlayer };
}

export function ownersOf(ownership: LeagueOwnership, playerId: number): number {
  return ownership.byPlayer.get(playerId)?.owners ?? 0;
}

/**
 * Average multiplier the sampled managers hold on a player. Managers without
 * the player contribute 0, so the divisor is the whole sample.
 */
export function averageMultiplierOf(ownership: LeagueOwnership, playerId: number): number {
  if (!ownership.sampleSize) return 0;
  return (ownership.byPlayer.get(playerId)?.totalMultiplier ?? 0) / ownership.sampleSize;
}

export function leagueAverageMultiplier(
  memberPicks: readonly EntryPicks[],
  playerId: number,
): number {
  return averageMultiplierOf(buildLeagueOwnership(memberPicks, false), playerId);
}

export function roundImpact(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The user's edge over the sampled managers on one scoring event: the points
 * that event was worth, scaled by how much stronger the user's multiplier is
 * than the sample's average. Where the sample is only the league's top rows the
 * comparison is against those rows, which is why the panel labels it.
 */
export function relativeLeagueImpact(
  pointsDelta: number,
  userMultiplier: number,
  averageMultiplier: number,
): number {
  return roundImpact(pointsDelta * (userMultiplier - averageMultiplier));
}

export type OwnershipStatus = "IDLE" | "LOADING" | "READY" | "ERROR";

/**
 * What the panel can honestly say about one event's league impact.
 * `SAMPLE` means the comparison is against the league's top rows rather than
 * all of it, which the panel has to show: a sample taken in rank order holds
 * popular players more often than the league as a whole, so the edge it
 * reports is an edge over those rows and not over everyone.
 */
export type ImpactReadout =
  | { kind: "READY"; impact: number; basis: "LEAGUE" | "SAMPLE"; sampleSize: number }
  | { kind: "LOADING" }
  | { kind: "UNAVAILABLE" };

export function readLeagueImpact(input: {
  ownership: LeagueOwnership;
  status: OwnershipStatus;
  playerId: number;
  pointsDelta: number;
  userMultiplier: number;
}): ImpactReadout {
  const { ownership, status, playerId, pointsDelta, userMultiplier } = input;
  if (status === "LOADING") return { kind: "LOADING" };
  if (status !== "READY" || ownership.sampleSize === 0) return { kind: "UNAVAILABLE" };
  return {
    kind: "READY",
    impact: relativeLeagueImpact(pointsDelta, userMultiplier, averageMultiplierOf(ownership, playerId)),
    basis: ownership.complete ? "LEAGUE" : "SAMPLE",
    sampleSize: ownership.sampleSize,
  };
}
