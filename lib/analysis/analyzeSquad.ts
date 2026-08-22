import type { SquadAnalysis, SquadOpportunity } from "../../types/analysis";
import type { Player, Position } from "../../types/player";
import {
  asPlayers,
  costOf,
  DEFAULT_BUDGET_TENTHS,
  expectedMinutes,
  fixtureDifficulty,
  horizonValue,
  normalizeSquad,
  playerMap,
  POSITIONS,
  POSITION_MINIMUMS,
  type CommonOptions,
  type PlayerUniverse,
  type SquadReference,
} from "./context";
import { findReplacements } from "./replacements";
import { rankWeaknesses } from "./weakness";
import { selectStartingXI } from "../squad/startingXI";

export interface AnalyzeSquadInput extends CommonOptions {
  squad: SquadReference;
  players?: PlayerUniverse;
  playerPool?: PlayerUniverse;
}

export interface AnalyzeSquadOptions extends CommonOptions {
  players?: PlayerUniverse;
  playerPool?: PlayerUniverse;
}

function projectionFor(player: Player, horizon: 1 | 3 | 5): number {
  return horizonValue(player, horizon);
}

function chooseStartingXI(ids: readonly number[], players: Map<number, Player>, horizon: 1 | 3 | 5): { startingXI: number[]; bench: number[] } {
  const selectedPlayers = ids.map((id) => players.get(id)).filter((player): player is Player => Boolean(player));
  if (selectedPlayers.length === 15) {
    try {
      const plan = selectStartingXI(selectedPlayers, {
        expectedPoints: Object.fromEntries(selectedPlayers.map((player) => [player.id, projectionFor(player, horizon)])),
      });
      const bench = [plan.bench.goalkeeperId, ...plan.bench.outfieldIds].filter((id): id is number => id !== undefined);
      return { startingXI: plan.playerIds, bench };
    } catch {
      // Partial or malformed squads still get a useful deterministic analysis below.
    }
  }
  const grouped: Record<Position, Player[]> = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const id of ids) {
    const player = players.get(id);
    if (player) grouped[player.position].push(player);
  }
  for (const position of POSITIONS) grouped[position].sort((a, b) => projectionFor(b, horizon) - projectionFor(a, horizon) || a.id - b.id);
  const goalkeeper = grouped.GK[0];
  if (!goalkeeper) return { startingXI: [], bench: ids.slice() };

  let best: { ids: number[]; score: number } | undefined;
  for (let defenders = 3; defenders <= 5; defenders += 1) {
    for (let midfielders = 2; midfielders <= 5; midfielders += 1) {
      const forwards = 10 - defenders - midfielders;
      if (forwards < 1 || forwards > 3) continue;
      if (grouped.DEF.length < defenders || grouped.MID.length < midfielders || grouped.FWD.length < forwards) continue;
      const picks = [
        goalkeeper,
        ...grouped.DEF.slice(0, defenders),
        ...grouped.MID.slice(0, midfielders),
        ...grouped.FWD.slice(0, forwards),
      ];
      const score = picks.reduce((sum, player) => sum + projectionFor(player, horizon), 0);
      if (!best || score > best.score || (score === best.score && defenders < best.ids.filter((id) => players.get(id)?.position === "DEF").length)) best = { ids: picks.map((player) => player.id), score };
    }
  }

  if (!best) {
    const fallback = [goalkeeper.id];
    for (const position of ["DEF", "MID", "FWD"] as const) fallback.push(...grouped[position].slice(0, Math.max(0, POSITION_MINIMUMS[position] - (position === "DEF" ? 2 : position === "MID" ? 2 : 1))).map((player) => player.id));
    best = { ids: fallback.slice(0, 11), score: 0 };
  }
  const starting = new Set(best.ids);
  return { startingXI: best.ids, bench: ids.filter((id) => !starting.has(id)) };
}

function buildStrengths(players: readonly Player[], horizon: 1 | 3 | 5): SquadAnalysis["strengths"] {
  if (!players.length) return [];
  const strengths: SquadAnalysis["strengths"] = [];
  const secure = players.filter((player) => expectedMinutes(player) >= 80).length / players.length;
  const averageFixtureDifficulty = players.reduce((sum, player) => sum + fixtureDifficulty(player, horizon), 0) / players.length;
  const projection = players.reduce((sum, player) => sum + horizonValue(player, horizon), 0);
  if (secure >= 0.7) strengths.push({ title: "Minutes security", detail: `${Math.round(secure * 100)}% of the squad projects for reliable minutes.`, severity: "POSITIVE" });
  if (averageFixtureDifficulty <= 0.45) strengths.push({ title: "Fixture outlook", detail: "The squad has a favourable average fixture run in the selected horizon.", severity: "POSITIVE" });
  if (projection > 0) strengths.push({ title: "Projection coverage", detail: `${projection.toFixed(1)} projected points are available across the selected horizon.`, severity: "INFO" });
  return strengths;
}

function buildWarnings(ids: readonly number[], players: Map<number, Player>, budgetTenths: number): string[] {
  const warnings: string[] = [];
  const counts: Record<Position, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  const clubs = new Map<number, number>();
  for (const id of ids) {
    const player = players.get(id);
    if (!player) continue;
    counts[player.position] += 1;
    clubs.set(player.teamId, (clubs.get(player.teamId) ?? 0) + 1);
  }
  if (ids.length < 15) warnings.push(`${15 - ids.length} squad slot${ids.length === 14 ? "" : "s"} still need filling.`);
  if (costOf(ids, players) > budgetTenths) warnings.push(`The squad is over budget by ${costOf(ids, players) - budgetTenths} tenths.`);
  for (const position of POSITIONS) if (counts[position] > POSITION_MINIMUMS[position]) warnings.push(`${position} has too many players.`);
  if ([...clubs.values()].some((count) => count > 3)) warnings.push("A club limit is exceeded.");
  if (players.size && ids.some((id) => !players.has(id))) warnings.push("One or more selected players are missing from the player universe.");
  return warnings;
}

function parseInput(
  input: AnalyzeSquadInput | SquadReference,
  playersOrOptions?: PlayerUniverse | AnalyzeSquadOptions,
  maybeOptions?: CommonOptions,
): AnalyzeSquadInput {
  if ("squad" in Object(input)) return input as AnalyzeSquadInput;
  if (playersOrOptions && typeof playersOrOptions === "object" && ("players" in playersOrOptions || "playerPool" in playersOrOptions)) {
    return { ...(playersOrOptions as AnalyzeSquadOptions), squad: input as SquadReference, players: (playersOrOptions as AnalyzeSquadOptions).players, playerPool: (playersOrOptions as AnalyzeSquadOptions).playerPool };
  }
  return { ...(maybeOptions ?? {}), squad: input as SquadReference, players: playersOrOptions as PlayerUniverse };
}

export function analyzeSquad(input: AnalyzeSquadInput): SquadAnalysis;
export function analyzeSquad(squad: SquadReference, players: PlayerUniverse, options?: CommonOptions): SquadAnalysis;
export function analyzeSquad(squad: SquadReference, options: AnalyzeSquadOptions): SquadAnalysis;
export function analyzeSquad(
  input: AnalyzeSquadInput | SquadReference,
  playersOrOptions?: PlayerUniverse | AnalyzeSquadOptions,
  maybeOptions?: CommonOptions,
): SquadAnalysis {
  const request = parseInput(input, playersOrOptions, maybeOptions);
  const fallbackPlayers = Array.isArray(request.squad) && request.squad.every((item) => typeof item !== "number") ? request.squad as readonly Player[] : [];
  const universe = asPlayers(request.players ?? request.playerPool ?? fallbackPlayers);
  const map = playerMap(universe);
  const normalized = normalizeSquad(request.squad, map);
  const horizon = request.horizon ?? 5;
  const selectedPlayers = normalized.playerIds.map((id) => map.get(id)).filter((player): player is Player => Boolean(player));
  const { startingXI, bench } = chooseStartingXI(normalized.playerIds, map, horizon);
  const startingSet = new Set(startingXI);
  const totalCostTenths = costOf(normalized.playerIds, map);
  const bankTenths = (request.budgetTenths ?? DEFAULT_BUDGET_TENTHS) - totalCostTenths;
  const projectedNextGW = startingXI.reduce((sum, id) => sum + horizonValue(map.get(id)!, 1), 0);
  const projectedNext3 = startingXI.reduce((sum, id) => sum + horizonValue(map.get(id)!, 3), 0);
  const projectedNext5 = startingXI.reduce((sum, id) => sum + horizonValue(map.get(id)!, 5), 0);
  const weaknesses = rankWeaknesses(selectedPlayers, universe, { horizon });
  const opportunities: SquadOpportunity[] = [];
  for (const weakness of weaknesses.slice(0, 3)) {
    const replacement = findReplacements({
      outgoingPlayerId: weakness.playerId,
      squad: normalized.playerIds,
      players: universe,
      horizon,
      risk: request.risk,
      excludedPlayerIds: request.excludedPlayerIds,
      budgetTenths: request.budgetTenths,
      maxPlayersPerClub: request.maxPlayersPerClub,
    })[0];
    if (replacement && replacement.projectedDelta > 0) opportunities.push({
      outgoingPlayerId: weakness.playerId,
      incomingPlayerId: replacement.playerId,
      projectedDelta: replacement.projectedDelta,
      priceDeltaTenths: replacement.priceTenths - (map.get(weakness.playerId)?.priceTenths ?? 0),
      reason: replacement.reason,
    });
  }
  const budgetAllocation: Record<Position | "bench", number> = { GK: 0, DEF: 0, MID: 0, FWD: 0, bench: 0 };
  for (const id of normalized.playerIds) {
    const player = map.get(id);
    if (!player) continue;
    if (startingSet.has(id)) budgetAllocation[player.position] += player.priceTenths;
    else budgetAllocation.bench += player.priceTenths;
  }
  return {
    totalCostTenths,
    bankTenths,
    projectedNextGW,
    projectedNext3,
    projectedNext5,
    startingXI,
    bench,
    strengths: buildStrengths(selectedPlayers, horizon),
    weaknesses,
    opportunities,
    structuralWarnings: buildWarnings(normalized.playerIds, map, request.budgetTenths ?? DEFAULT_BUDGET_TENTHS),
    budgetAllocation,
  };
}

export default analyzeSquad;
