import loadHighs from "highs";

import type { Player, Position } from "@/types/player";
import type { OptimizerInput, OptimizerResult } from "./optimizer";
import { analyzeSquad } from "@/lib/analysis/analyzeSquad";
import { probabilityDidNotPlay } from "@/lib/squad/weeklyLineup";
import {
  asPlayers,
  DEFAULT_BUDGET_TENTHS,
  DEFAULT_MAX_PLAYERS_PER_CLUB,
  idsFromSquad,
  legalSquad,
  normalizeSquad,
  playerMap,
  POSITIONS,
  POSITION_MINIMUMS,
  gameweekValue,
} from "@/lib/analysis/context";

export type ExactOptimizerInput = Omit<OptimizerInput, "risk" | "strategy">;

export interface ExactOptimizerResult extends OptimizerResult {
  optimal?: true;
  solver?: "HIGHS";
  objective?: number;
  captainsByGameweek?: Array<{ gameweek: number; playerId: number }>;
}

const STARTER_MINIMUMS: Record<Position, number> = { GK: 1, DEF: 3, MID: 2, FWD: 1 };
const highsPromise = loadHighs();

function likelyStartingXi(players: readonly Player[], gameweek: number): Player[] {
  const ranked = [...players].sort((a, b) =>
    gameweekValue(b, gameweek) - gameweekValue(a, gameweek)
    || probabilityDidNotPlay(a, gameweek) - probabilityDidNotPlay(b, gameweek)
    || a.id - b.id);
  const selected = POSITIONS.flatMap((position) => ranked
    .filter((player) => player.position === position)
    .slice(0, STARTER_MINIMUMS[position]));
  const selectedIds = new Set(selected.map((player) => player.id));
  for (const player of ranked) {
    if (selected.length === 11) break;
    if (player.position !== "GK" && !selectedIds.has(player.id)
      && selected.filter((candidate) => candidate.position === player.position).length < POSITION_MINIMUMS[player.position]) {
      selected.push(player);
      selectedIds.add(player.id);
    }
  }
  return selected;
}

function reserveDemand(players: readonly Player[], gameweek: number) {
  const starters = likelyStartingXi(players, gameweek);
  const goalkeeper = starters.find((player) => player.position === "GK");
  const outfield = starters.filter((player) => player.position !== "GK");
  const probabilities = outfield.map((player) => probabilityDidNotPlay(player, gameweek));
  return {
    goalkeeper: goalkeeper ? probabilityDidNotPlay(goalkeeper, gameweek) : 0,
    balanced: Math.min(1, probabilities.reduce((sum, probability) => sum + probability, 0) / 3),
    strong: 1 - probabilities.reduce((allPlay, probability) => allPlay * (1 - probability), 1),
  };
}

function reserveValue(
  player: Player,
  points: number,
  gameweek: number,
  bench: NonNullable<ExactOptimizerInput["bench"]>,
  demand: ReturnType<typeof reserveDemand>,
  minimumPrice: number,
): number {
  const use = player.position === "GK" ? demand.goalkeeper : bench === "STRONG" ? demand.strong : demand.balanced;
  const value = points * use * (1 - probabilityDidNotPlay(player, gameweek));
  if (bench !== "CHEAP") return value;
  return value * minimumPrice / Math.max(minimumPrice, player.priceTenths) - player.priceTenths * 0.000001;
}

function idsFromInput(input: ExactOptimizerInput): number[] {
  return idsFromSquad(input.currentSquad ?? input.squad);
}

function term(coefficient: number, variable: string): string {
  const sign = coefficient < 0 ? "-" : "+";
  return `${sign} ${Math.abs(coefficient).toFixed(8)} ${variable}`;
}

function expression(terms: Array<[number, string]>): string {
  return terms.filter(([coefficient]) => Math.abs(coefficient) > 1e-12).map(([coefficient, variable]) => term(coefficient, variable)).join(" ") || "0";
}

function exactFailure(ids: readonly number[], players: Map<number, Player>, errors: string[]): ExactOptimizerResult {
  return { legal: false, playerIds: [...ids], squad: normalizeSquad(ids, players), errors, warnings: [] };
}

async function solveExact(input: ExactOptimizerInput, fixedIds: readonly number[]): Promise<ExactOptimizerResult> {
  const allPlayers = asPlayers(input.players ?? input.playerPool ?? []).sort((a, b) => a.id - b.id);
  const map = playerMap(allPlayers);
  const fixed = [...new Set(fixedIds)];
  const excluded = new Set(input.excludedPlayerIds ?? []);
  const errors: string[] = [];
  for (const id of fixed) {
    if (!map.has(id)) errors.push(`Player ${id} is not in the player universe.`);
    if (excluded.has(id)) errors.push(`Player ${id} is excluded.`);
  }
  const fixedValidation = legalSquad(fixed, map, {
    budgetTenths: input.budgetTenths ?? DEFAULT_BUDGET_TENTHS,
    maxPlayersPerClub: input.maxPlayersPerClub ?? DEFAULT_MAX_PLAYERS_PER_CLUB,
  });
  for (const error of fixedValidation.errors) {
    if (error.startsWith("Squad must contain 15") || /requires \d+ players \(received/.test(error)) continue;
    errors.push(error);
  }
  if (errors.length) return exactFailure(fixed, map, errors);

  const players = allPlayers.filter((player) => !excluded.has(player.id));
  const horizon = input.horizon ?? 5;
  const bench = input.bench ?? "BALANCED";
  const budget = input.budgetTenths ?? DEFAULT_BUDGET_TENTHS;
  const maxPerClub = input.maxPlayersPerClub ?? DEFAULT_MAX_PLAYERS_PER_CLUB;
  const projectedGameweeks = players.flatMap((player) => player.projection?.fixtures.map((fixture) => fixture.gameweek) ?? []);
  const firstProjectedGameweek = projectedGameweeks.length ? Math.min(...projectedGameweeks) : 1;
  const lastProjectedGameweek = projectedGameweeks.length ? Math.max(...projectedGameweeks) : 1;
  // The squad is built for the gameweek the user is planning, not the live one.
  const planGameweek = input.gameweek ?? firstProjectedGameweek;
  // Internal chip-planning use: an explicit list of gameweeks to solve over
  // (Free Hit: one gameweek; Wildcard: remaining selected horizon).
  const gameweeks = Array.isArray(input.gameweeks) && input.gameweeks.length
    ? [...input.gameweeks].filter((gw) => Number.isSafeInteger(gw) && gw >= 1 && gw <= 38).sort((a, b) => a - b)
    : Array.from({ length: horizon }, (_, offset) => planGameweek + offset);
  const benchBoost = input.benchBoost === true;
  const reserveDemands = gameweeks.map((gameweek) => reserveDemand(players, gameweek));
  const minimumPrices = Object.fromEntries(POSITIONS.map((position) => [
    position,
    Math.min(...players.filter((player) => player.position === position).map((player) => player.priceTenths)),
  ])) as Record<Position, number>;
  const solverWarnings: string[] = [];
  if (planGameweek < firstProjectedGameweek || gameweeks[gameweeks.length - 1] > lastProjectedGameweek) {
    solverWarnings.push(`Projections cover Gameweeks ${firstProjectedGameweek}-${lastProjectedGameweek}; Gameweeks outside that range score zero.`);
  }
  const objective: Array<[number, string]> = [];
  const binaries: string[] = [];
  const constraints: string[] = [];
  const squad = (id: number) => `x_${id}`;
  const starter = (gameweek: number, id: number) => `s${gameweek}_${id}`;
  const captain = (gameweek: number, id: number) => `c${gameweek}_${id}`;

  for (const player of players) {
    binaries.push(squad(player.id));
    const weeklyPoints = gameweeks.map((gameweek) => gameweekValue(player, gameweek));
    const reservePoints = weeklyPoints.map((points, index) => reserveValue(
      player,
      points,
      gameweeks[index],
      bench,
      reserveDemands[index],
      minimumPrices[player.position],
    ));
    objective.push([benchBoost ? weeklyPoints.reduce((sum, points) => sum + points, 0) : reservePoints.reduce((sum, points) => sum + points, 0), squad(player.id)]);
    for (const [weekIndex, gameweek] of gameweeks.entries()) {
      const starterVariable = starter(gameweek, player.id);
      const captainVariable = captain(gameweek, player.id);
      binaries.push(starterVariable, captainVariable);
      const points = weeklyPoints[weekIndex];
      if (!benchBoost) objective.push([points - reservePoints[weekIndex], starterVariable]);
      objective.push([points, captainVariable]);
      constraints.push(`starter_squad_${gameweek}_${player.id}: ${expression([[1, starterVariable], [-1, squad(player.id)]])} <= 0`);
      constraints.push(`captain_starter_${gameweek}_${player.id}: ${expression([[1, captainVariable], [-1, starterVariable]])} <= 0`);
    }
  }

  constraints.push(`squad_size: ${expression(players.map((player) => [1, squad(player.id)]))} = 15`);
  constraints.push(`budget: ${expression(players.map((player) => [player.priceTenths, squad(player.id)]))} <= ${budget}`);
  for (const position of POSITIONS) {
    const members = players.filter((player) => player.position === position);
    constraints.push(`squad_${position}: ${expression(members.map((player) => [1, squad(player.id)]))} = ${POSITION_MINIMUMS[position]}`);
    for (const gameweek of gameweeks) {
      constraints.push(`starters_${gameweek}_${position}: ${expression(members.map((player) => [1, starter(gameweek, player.id)]))} >= ${STARTER_MINIMUMS[position]}`);
      if (position === "GK") constraints.push(`starter_${gameweek}_gk_max: ${expression(members.map((player) => [1, starter(gameweek, player.id)]))} <= 1`);
    }
  }
  for (const teamId of new Set(players.map((player) => player.teamId))) {
    const members = players.filter((player) => player.teamId === teamId);
    constraints.push(`club_${teamId}: ${expression(members.map((player) => [1, squad(player.id)]))} <= ${maxPerClub}`);
  }
  for (const id of fixed) constraints.push(`fixed_${id}: ${squad(id)} = 1`);
  for (const gameweek of gameweeks) {
    constraints.push(`starter_size_${gameweek}: ${expression(players.map((player) => [1, starter(gameweek, player.id)]))} = 11`);
    constraints.push(`captain_${gameweek}: ${expression(players.map((player) => [1, captain(gameweek, player.id)]))} = 1`);
  }

  const lp = [
    "Maximize",
    ` objective: ${expression(objective)}`,
    "Subject To",
    ...constraints.map((constraint) => ` ${constraint}`),
    "Binary",
    ...binaries.map((variable) => ` ${variable}`),
    "End",
  ].join("\n");
  const highs = await highsPromise;
  const result = highs.solve(lp, { output_flag: false, log_to_console: false, mip_rel_gap: 0, presolve: "on", random_seed: 0 });
  if (result.Status !== "Optimal") return exactFailure(fixed, map, [`Exact optimizer returned ${result.Status}.`]);
  const selectedIds = players.filter((player) => result.Columns[squad(player.id)]?.Primal > 0.5).map((player) => player.id);
  const validation = legalSquad(selectedIds, map, { budgetTenths: budget, maxPlayersPerClub: maxPerClub, excludedPlayerIds: input.excludedPlayerIds });
  if (!validation.legal) return exactFailure(fixed, map, validation.errors);
  const normalized = normalizeSquad(selectedIds, map);
  const analysis = analyzeSquad({ squad: normalized, players: allPlayers, horizon, bench, budgetTenths: budget, maxPlayersPerClub: maxPerClub });
  return {
    legal: true,
    squad: normalized,
    playerIds: selectedIds,
    analysis,
    score: result.ObjectiveValue,
    objective: result.ObjectiveValue,
    optimal: true,
    solver: "HIGHS",
    captainsByGameweek: gameweeks.map((gameweek) => ({
      gameweek,
      playerId: players.find((player) => result.Columns[captain(gameweek, player.id)]?.Primal > 0.5)?.id ?? 0,
    })),
    errors: [],
    warnings: [...solverWarnings, ...analysis.structuralWarnings],
  };
}

export function exactOptimizeFullSquad(input: ExactOptimizerInput): Promise<ExactOptimizerResult> {
  const ids = idsFromInput(input);
  const locked = input.lockedPlayerIds ?? [];
  return solveExact(input, locked.length ? locked : ids.length < 15 ? ids : []);
}

export function exactCompletePartialSquad(input: ExactOptimizerInput): Promise<ExactOptimizerResult> {
  return solveExact(input, idsFromInput(input));
}
