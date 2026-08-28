import type { Player, Position, ProjectionConfidence } from "../../types/player";
import type { SquadState } from "../../types/squad";
import type { Horizon } from "../../types/projection";
import { projectPlayer } from "../projections/projectPlayer";
import { weeklyPlayerMetrics } from "../squad/weeklyLineup";

export type PlayerUniverse = readonly Player[] | ReadonlyMap<number, Player> | Record<string, Player>;
export type SquadReference = SquadState | readonly number[] | readonly Player[];

export interface AnalysisStrategy {
  horizon?: Horizon;
  risk?: "SAFE" | "BALANCED" | "AGGRESSIVE";
  bench?: "CHEAP" | "BALANCED" | "STRONG";
  availability?: "ANY" | "AVAILABLE" | "NAILED";
}

export interface CommonOptions extends AnalysisStrategy {
  strategy?: AnalysisStrategy;
  budgetTenths?: number;
  maxPlayersPerClub?: number;
  lockedPlayerIds?: readonly number[];
  excludedPlayerIds?: readonly number[];
  players?: PlayerUniverse;
}

export interface NormalizedSquad {
  playerIds: number[];
  byPosition: Record<Position, number[]>;
}

export const POSITIONS: readonly Position[] = ["GK", "DEF", "MID", "FWD"];
export const POSITION_LIMITS: Record<Position, number> = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
export const POSITION_MINIMUMS: Record<Position, number> = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
export const DEFAULT_BUDGET_TENTHS = 1000;
export const DEFAULT_MAX_PLAYERS_PER_CLUB = 3;

export function asPlayers(value: PlayerUniverse | undefined): Player[] {
  if (!value) return [];
  if (Array.isArray(value)) return [...value];
  if (value instanceof Map) return [...value.values()];
  return Object.values(value);
}

export function playerMap(players: PlayerUniverse | undefined): Map<number, Player> {
  return new Map(asPlayers(players).map((player) => [player.id, player]));
}

export function idsFromSquad(squad: SquadReference | undefined): number[] {
  if (!squad) return [];
  if (Array.isArray(squad)) return squad.map((item) => typeof item === "number" ? item : item.id);
  const state = squad as SquadState;
  if (Array.isArray(state.playerIds)) return [...state.playerIds];
  return POSITIONS.flatMap((position) => state.byPosition?.[position] ?? []);
}

export function normalizeSquad(
  squad: SquadReference | undefined,
  players: Map<number, Player>,
): NormalizedSquad {
  const playerIds = idsFromSquad(squad).filter((id, index, all) => all.indexOf(id) === index);
  const byPosition: Record<Position, number[]> = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const id of playerIds) {
    const position = players.get(id)?.position;
    if (position) byPosition[position].push(id);
  }
  return { playerIds, byPosition };
}

export function horizonValue(player: Player, horizon: Horizon = 5): number {
  const projection = player.projection ?? projectPlayer(player, { horizon });
  if (projection) {
    const value = horizon === 1 ? projection.nextGW : horizon === 3 ? projection.next3 : horizon === 5 ? projection.next5 : projection.next10;
    if (Number.isFinite(value) && (value > 0 || player.fixtures.length > 0 || player.current.totalPoints === 0)) return Math.max(0, value);
  }

  const minutes = projection?.expectedMinutes ?? player.current.minutes;
  const per90 = player.current.pointsPer90 ??
    (player.current.minutes > 0 ? (player.current.totalPoints / player.current.minutes) * 90 : 0);
  const nextGameweek = Math.max(0, (per90 * Math.max(0, minutes)) / 90);
  return nextGameweek * horizon;
}

export function nextGameweekValue(player: Player): number {
  return horizonValue(player, 1);
}

export function expectedMinutes(player: Player): number {
  const value = player.projection?.expectedMinutes ?? projectPlayer(player).expectedMinutes;
  return Number.isFinite(value) ? Math.max(0, Math.min(90, value as number)) : Math.max(0, Math.min(90, player.current.minutes > 0 ? 90 : 0));
}

export function confidenceWeight(confidence: ProjectionConfidence | undefined): number {
  return confidence === "HIGH" ? 1 : confidence === "LOW" ? 0.7 : 0.85;
}

export function availabilityRisk(player: Player): number {
  const status = String(player.status ?? "").toLowerCase();
  const chance = player.chanceOfPlaying;
  let risk = 0;
  if (status === "i" || status === "s") risk += 0.75;
  else if (status === "d" || status === "u") risk += 0.35;
  if (typeof chance === "number") risk += Math.max(0, 1 - chance / 100) * 0.65;
  return Math.min(1, risk);
}

export function fixtureDifficulty(player: Player, horizon = 5): number {
  const fixtures = player.fixtures.slice(0, horizon);
  if (!fixtures.length) return 0.5;
  const total = fixtures.reduce((sum, fixture) => sum + (fixture.difficulty ?? 3), 0);
  return Math.max(0, Math.min(1, (total / fixtures.length - 1) / 4));
}

/** Scales raw projected points by minutes, confidence, availability, and risk appetite. */
function utilityScale(player: Player, risk: CommonOptions["risk"] = "BALANCED"): number {
  const minutes = expectedMinutes(player) / 100;
  const confidence = confidenceWeight(player.projection?.confidence);
  const availability = 1 - availabilityRisk(player);
  const riskMultiplier = risk === "SAFE" ? 0.72 : risk === "AGGRESSIVE" ? 1.08 : 0.9;
  return (0.62 + 0.16 * minutes + 0.12 * confidence + 0.1 * availability) * riskMultiplier;
}

export function utilityValue(player: Player, horizon = 5, risk: CommonOptions["risk"] = "BALANCED"): number {
  return horizonValue(player, horizon as Horizon) * utilityScale(player, risk);
}

/**
 * Points projected for one named gameweek. Unlike horizonValue, which always
 * starts at the live gameweek, this answers "what is this player worth in GW n",
 * so a plan built for a later gameweek scores that gameweek. Doubles sum, blanks
 * return zero.
 */
export function gameweekValue(player: Player, gameweek: number): number {
  if (!player.projection) return horizonValue(player, 1);
  return Math.max(0, weeklyPlayerMetrics(player, gameweek).points);
}

/** Points projected across `horizon` gameweeks starting at `gameweek`. */
export function windowValue(player: Player, gameweek: number, horizon: Horizon = 5): number {
  return Array.from({ length: horizon }, (_, offset) => gameweekValue(player, gameweek + offset))
    .reduce((sum, value) => sum + value, 0);
}

/** utilityValue for an explicit gameweek window rather than the live one. */
export function windowUtility(
  player: Player,
  gameweek: number,
  horizon: Horizon = 5,
  risk: CommonOptions["risk"] = "BALANCED",
): number {
  return windowValue(player, gameweek, horizon) * utilityScale(player, risk);
}

export function costOf(ids: readonly number[], players: Map<number, Player>): number {
  return ids.reduce((total, id) => total + (players.get(id)?.priceTenths ?? 0), 0);
}

export function clubCounts(ids: readonly number[], players: Map<number, Player>): Map<number, number> {
  const counts = new Map<number, number>();
  for (const id of ids) {
    const club = players.get(id)?.teamId;
    if (club !== undefined) counts.set(club, (counts.get(club) ?? 0) + 1);
  }
  return counts;
}

export function hasAvailabilityRisk(player: Player): boolean {
  return availabilityRisk(player) >= 0.5;
}

export function isPositionComplete(ids: readonly number[], players: Map<number, Player>): boolean {
  const counts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const id of ids) {
    const position = players.get(id)?.position;
    if (position) counts[position] += 1;
  }
  return POSITIONS.every((position) => counts[position] === POSITION_MINIMUMS[position]);
}

export function legalSquad(
  ids: readonly number[],
  players: Map<number, Player>,
  options: Pick<CommonOptions, "budgetTenths" | "maxPlayersPerClub" | "excludedPlayerIds"> = {},
): { legal: boolean; errors: string[] } {
  const errors: string[] = [];
  const budget = options.budgetTenths ?? DEFAULT_BUDGET_TENTHS;
  const maxPerClub = options.maxPlayersPerClub ?? DEFAULT_MAX_PLAYERS_PER_CLUB;
  const excluded = new Set(options.excludedPlayerIds ?? []);
  const unique = new Set(ids);
  if (unique.size !== ids.length) errors.push("Squad contains duplicate players.");
  if (ids.length !== 15) errors.push(`Squad must contain 15 players (received ${ids.length}).`);
  const counts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  const clubs = clubCounts(ids, players);
  for (const id of ids) {
    const player = players.get(id);
    if (!player) {
      errors.push(`Player ${id} is not in the player universe.`);
      continue;
    }
    counts[player.position] += 1;
    if (excluded.has(id)) errors.push(`${player.displayName} is excluded.`);
  }
  for (const position of POSITIONS) {
    if (counts[position] !== POSITION_MINIMUMS[position]) errors.push(`${position} requires ${POSITION_MINIMUMS[position]} players (received ${counts[position]}).`);
  }
  for (const [club, count] of clubs) if (count > maxPerClub) errors.push(`Club ${club} has ${count} players (maximum ${maxPerClub}).`);
  const cost = costOf(ids, players);
  if (cost > budget) errors.push(`Squad costs ${cost} tenths and exceeds the ${budget}-tenths budget.`);
  return { legal: errors.length === 0, errors };
}

export function formatPrice(tenths: number): string {
  return `£${(tenths / 10).toFixed(1)}m`;
}
