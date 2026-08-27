import type { Player } from "../../types/player";
import type { SquadWeakness } from "../../types/analysis";
import type { Horizon } from "../../types/projection";
import {
  availabilityRisk,
  confidenceWeight,
  expectedMinutes,
  fixtureDifficulty,
  horizonValue,
  playerMap,
  type PlayerUniverse,
} from "./context";

export interface WeaknessOptions {
  horizon?: Horizon;
  players?: PlayerUniverse;
}

function percentileDeficit(value: number, peers: readonly number[]): number {
  if (peers.length < 2) return 0.5;
  const lower = peers.filter((peer) => peer < value).length;
  return 1 - lower / (peers.length - 1);
}

function statusLabel(player: Player): string {
  const status = String(player.status ?? "").toLowerCase();
  if (status === "i") return "Unavailable";
  if (status === "d" || status === "u") return "Availability risk";
  if (typeof player.chanceOfPlaying === "number" && player.chanceOfPlaying < 75) return "Availability risk";
  return "Minutes security";
}

export interface WeaknessScore {
  score: number;
  reasons: string[];
  components: {
    projection: number;
    value: number;
    fixtures: number;
    minutes: number;
    availability: number;
    confidence: number;
  };
}

export function scoreWeakness(
  player: Player,
  peers: readonly Player[] = [],
  options: WeaknessOptions = {},
): WeaknessScore {
  const horizon = options.horizon ?? 5;
  const pool = peers.filter((candidate) => candidate.position === player.position);
  const values = pool.map((candidate) => horizonValue(candidate, horizon));
  const valueScores = pool.map((candidate) => {
    const price = Math.max(1, candidate.priceTenths);
    return horizonValue(candidate, horizon) / price;
  });
  const playerProjection = horizonValue(player, horizon);
  const playerValue = playerProjection / Math.max(1, player.priceTenths);
  const components = {
    projection: percentileDeficit(playerProjection, values),
    value: percentileDeficit(playerValue, valueScores),
    fixtures: fixtureDifficulty(player, horizon),
    minutes: Math.max(0, 1 - expectedMinutes(player) / 90),
    availability: availabilityRisk(player),
    confidence: 1 - confidenceWeight(player.projection?.confidence),
  };

  // Projection and minutes dominate, while fixtures, value and model uncertainty temper the result.
  const score = Math.round(Math.max(0, Math.min(100,
    components.projection * 30 +
    components.value * 20 +
    components.fixtures * 15 +
    components.minutes * 15 +
    components.availability * 12 +
    components.confidence * 8,
  )));
  const reasons: string[] = [];
  if (components.projection >= 0.6) reasons.push(`Low ${horizon}GW projection`);
  if (components.value >= 0.6) reasons.push("Poor price efficiency");
  if (components.fixtures >= 0.6) reasons.push("Difficult upcoming fixtures");
  if (components.minutes >= 0.35) reasons.push(`Low ${statusLabel(player).toLowerCase()}`);
  if (components.availability >= 0.35) reasons.push(statusLabel(player));
  if (components.confidence >= 0.25) reasons.push("Low projection confidence");
  if (!reasons.length) reasons.push("No major weakness in the available model inputs");
  return { score, reasons, components };
}

export function weaknessForPlayer(
  player: Player,
  players: PlayerUniverse,
  options: WeaknessOptions = {},
): SquadWeakness {
  const universe = [...playerMap(players).values()];
  const result = scoreWeakness(player, universe, options);
  return { playerId: player.id, score: result.score, reasons: result.reasons };
}

export function rankWeaknesses(
  players: readonly Player[],
  universe: PlayerUniverse = players,
  options: WeaknessOptions = {},
): SquadWeakness[] {
  const pool = [...playerMap(universe).values()];
  return players
    .map((player) => {
      const result = scoreWeakness(player, pool, options);
      return { playerId: player.id, score: result.score, reasons: result.reasons };
    })
    .sort((a, b) => b.score - a.score || a.playerId - b.playerId);
}
